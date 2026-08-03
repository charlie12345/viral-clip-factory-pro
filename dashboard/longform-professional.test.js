'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildLongformEdl,
    buildLongformFcpxml,
    buildLongformOtio,
    flattenSequenceForRender,
    interchangeDigest,
    normalizeGrade,
    normalizeLongformProfessional,
    sequenceTimelineItems,
    supplementQcReport,
} = require('./longform-professional');

function professionalInput() {
    return {
        color: {
            exposure: 2,
            gamma: 0,
            lutAssetId: 'library--film.cube',
        },
        sequence: {
            enabled: true,
            mode: 'replace',
            activeSequenceId: 'main',
            sourceIn: 1,
            sourceOut: 9,
            markers: [{ id: 'review marker', time: 3, label: 'Fix this', source: 'review' }],
            sequences: [
                {
                    id: 'main',
                    name: 'Main',
                    frameRate: 24,
                    width: 3840,
                    height: 2160,
                    tracks: [{
                        id: 'v1',
                        name: 'Picture',
                        kind: 'video',
                        order: 0,
                        clips: [{
                            id: 'nested',
                            name: 'Compound',
                            sourceType: 'sequence',
                            nestedSequenceId: 'compound',
                            sourceStart: 0,
                            sourceEnd: 2,
                            timelineStart: 4,
                            timelineEnd: 6,
                        }],
                    }],
                },
                {
                    id: 'compound',
                    name: 'Compound',
                    frameRate: 24,
                    tracks: [{
                        id: 'v2',
                        name: 'Nested picture',
                        kind: 'video',
                        order: 0,
                        clips: [{
                            id: 'asset-clip',
                            name: 'Camera B',
                            sourceType: 'asset',
                            assetId: 'media--camera-b.mp4',
                            sourceStart: 2,
                            sourceEnd: 4,
                            timelineStart: 0.5,
                            timelineEnd: 2.5,
                            includeAudio: true,
                            speed: {
                                rate: 99,
                                reverse: true,
                                opticalFlow: true,
                                keyframes: [
                                    { sourceTime: 2, speed: 0 },
                                    { sourceTime: 3, speed: 2 },
                                ],
                            },
                            stabilization: { enabled: true, strength: 500, method: 'two_pass' },
                            chromaKey: { enabled: true, color: '#0f0', similarity: 2 },
                            masks: [{
                                id: 'face',
                                type: 'ellipse',
                                effect: 'mosaic',
                                strength: 120,
                                keyframes: [{ time: 5, x: 0.4 }, { time: 4, x: 0.3 }],
                            }],
                        }],
                    }],
                },
            ],
        },
        colorWorkflow: {
            management: {
                inputSpace: 'slog3',
                workingSpace: 'acescct',
                outputSpace: 'hdr10',
                toneMap: 'hable',
                legalize: true,
                peakNits: 20_000,
            },
            versions: [{
                id: 'auto-1',
                name: 'Auto grade',
                source: 'auto',
                grade: { exposure: 0.1 },
            }],
            selectedVersionId: 'auto-1',
            groups: [{
                id: 'interview',
                name: 'Interview',
                clipIds: ['asset-clip'],
                grade: { saturation: 1.2 },
            }],
        },
        adr: {
            latencyMs: -100,
            countdownSec: 20,
            cues: [{
                id: 'cue',
                start: 2,
                end: 3,
                text: 'Replacement line',
                takeAssetIds: ['voiceover--take.webm'],
            }],
        },
        publish: {
            title: 'Episode',
            shortsCount: 99,
            shortDurationSec: 2,
            destinations: ['youtube', 'archive'],
        },
    };
}

test('professional schema clamps unsafe values while preserving reversible editor state', () => {
    const normalized = normalizeLongformProfessional(professionalInput(), {}, {
        start: 0,
        end: 10,
        duration: 10,
    });
    const clip = normalized.sequence.sequences[1].tracks[0].clips[0];

    assert.equal(normalized.sequence.enabled, true);
    assert.equal(normalized.sequence.mode, 'replace');
    assert.equal(clip.speed.rate, 16);
    assert.equal(clip.speed.keyframes[0].speed, 0.05);
    assert.equal(clip.stabilization.strength, 64);
    assert.equal(clip.chromaKey.color, '#00FF00');
    assert.equal(clip.chromaKey.similarity, 1);
    assert.equal(clip.masks[0].strength, 100);
    assert.deepEqual(clip.masks[0].keyframes.map((item) => item.time), [4, 5]);
    assert.equal(normalized.colorWorkflow.management.peakNits, 10_000);
    assert.equal(normalized.colorWorkflow.selectedVersionId, 'auto-1');
    assert.equal(normalized.adr.countdownSec, 10);
    assert.equal(normalized.publish.shortsCount, 12);
    assert.equal(normalized.publish.shortDurationSec, 10);
    assert.deepEqual(normalizeGrade(professionalInput().color), {
        exposure: 0.5,
        contrast: 1,
        saturation: 1,
        vibrance: 0,
        gamma: 0.35,
        highlights: 0,
        shadows: 0,
        temperature: 0,
        tint: 0,
        sharpen: 0,
        lutAssetId: 'library--film.cube',
    });
});

test('nested sequences flatten to resolved timeline media and interchange formats', () => {
    const normalized = normalizeLongformProfessional(professionalInput(), {}, {
        start: 0,
        end: 10,
        duration: 10,
    });
    const context = {
        sourcePath: '/media/program.mp4',
        resolveAsset: (assetId) => assetId === 'media--camera-b.mp4' ? '/media/camera-b.mp4' : null,
    };
    const flattened = flattenSequenceForRender(normalized.sequence, context);
    const clip = flattened.tracks[0].clips[0];
    assert.equal(clip.path, '/media/camera-b.mp4');
    assert.equal(clip.timelineStart, 4.5);
    assert.equal(clip.timelineEnd, 6.5);

    const items = sequenceTimelineItems(normalized.sequence, context);
    assert.equal(items.length, 1);
    assert.equal(items[0].trackName, 'Picture');
    assert.match(buildLongformEdl(items, { title: 'Episode', frameRate: 24 }), /EFFECT: REVERSE/);
    assert.match(buildLongformFcpxml(items, { title: 'Episode', frameRate: 24 }), /camera-b\.mp4/);
    const otio = JSON.parse(buildLongformOtio(items, { title: 'Episode', frameRate: 24 }));
    assert.equal(otio.tracks.children[0].children.at(-1).media_reference.target_url, 'file:///media/camera-b.mp4');
    assert.equal(
        interchangeDigest(items, { title: 'Episode' }),
        interchangeDigest(items, { title: 'Episode' }),
    );
});

test('QC supplementation catches timeline, caption, and delivery problems', () => {
    const normalized = normalizeLongformProfessional(professionalInput(), {}, {
        start: 0,
        end: 10,
        duration: 10,
    });
    const report = supplementQcReport(
        { issues: [], summary: {} },
        {
            ...normalized,
            captions: {
                cues: [
                    { start: 0, end: 1, text: 'A'.repeat(40) },
                    { start: 0.8, end: 2, text: 'Overlap' },
                ],
            },
            publish: { ...normalized.publish, title: '' },
        },
        {
            sourcePath: '/media/program.mp4',
            resolveAsset: () => null,
            chapters: [],
        },
    );
    const ids = new Set(report.issues.map((issue) => issue.id));
    assert.equal(ids.has('caption-overlap-1'), true);
    assert.equal(ids.has('caption-speed-0'), true);
    assert.equal(ids.has('missing-asset-clip'), true);
    assert.equal(ids.has('missing-chapters'), true);
    assert.equal(ids.has('missing-publish-title'), true);
    assert.equal(report.summary.passed, false);
});
