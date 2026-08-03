const crypto = require('crypto');
const path = require('path');

const MAX_SEQUENCE_DURATION = 24 * 60 * 60;
const DEFAULT_FRAME_RATE = 30;

function number(value, fallback, min = -Infinity, max = Infinity) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function text(value, fallback = '', maxLength = 160) {
    return String(value ?? fallback).trim().slice(0, maxLength);
}

function id(value, fallback) {
    return String(value || fallback || '')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 100);
}

function color(value, fallback) {
    const normalized = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized.toUpperCase();
    if (/^#[0-9a-f]{3}$/i.test(normalized)) {
        return `#${normalized.slice(1).split('').map((part) => part + part).join('')}`.toUpperCase();
    }
    return fallback;
}

function normalizeGrade(input = {}, fallback = {}) {
    const source = { ...fallback, ...(input && typeof input === 'object' ? input : {}) };
    return {
        exposure: number(source.exposure, 0, -0.5, 0.5),
        contrast: number(source.contrast, 1, 0.25, 2),
        saturation: number(source.saturation, 1, 0, 3),
        vibrance: number(source.vibrance, 0, -1, 1),
        gamma: number(source.gamma, 1, 0.35, 3),
        highlights: number(source.highlights, 0, -1, 1),
        shadows: number(source.shadows, 0, -1, 1),
        temperature: number(source.temperature, 0, -1, 1),
        tint: number(source.tint, 0, -1, 1),
        sharpen: number(source.sharpen, 0, 0, 2),
        lutAssetId: source.lutAssetId ? text(source.lutAssetId, '', 240) : null,
    };
}

function normalizeMaskKeyframes(input) {
    return (Array.isArray(input) ? input : []).slice(0, 1000).map((item, index) => ({
        id: id(item?.id, `mask-keyframe-${index + 1}`),
        time: number(item?.time, 0, 0, MAX_SEQUENCE_DURATION),
        x: number(item?.x, 0.25, -1, 2),
        y: number(item?.y, 0.25, -1, 2),
        width: number(item?.width, 0.25, 0.005, 2),
        height: number(item?.height, 0.25, 0.005, 2),
        rotation: number(item?.rotation, 0, -360, 360),
    })).sort((left, right) => left.time - right.time);
}

function normalizeMasks(input) {
    const shapeTypes = new Set(['rectangle', 'ellipse', 'pen', 'gradient']);
    const effectTypes = new Set(['blur', 'mosaic', 'opacity', 'color']);
    return (Array.isArray(input) ? input : []).slice(0, 64).map((item, index) => ({
        id: id(item?.id, `mask-${index + 1}`),
        name: text(item?.name, `Mask ${index + 1}`, 80),
        enabled: item?.enabled !== false,
        type: shapeTypes.has(item?.type) ? item.type : 'rectangle',
        effect: effectTypes.has(item?.effect) ? item.effect : 'blur',
        x: number(item?.x, 0.25, -1, 2),
        y: number(item?.y, 0.25, -1, 2),
        width: number(item?.width, 0.25, 0.005, 2),
        height: number(item?.height, 0.25, 0.005, 2),
        rotation: number(item?.rotation, 0, -360, 360),
        feather: number(item?.feather, 0.08, 0, 1),
        strength: number(item?.strength, 18, 0, 100),
        invert: item?.invert === true,
        fillColor: color(item?.fillColor, '#000000'),
        points: (Array.isArray(item?.points) ? item.points : []).slice(0, 500).map((point) => ({
            x: number(point?.x, 0.5, -1, 2),
            y: number(point?.y, 0.5, -1, 2),
        })),
        keyframes: normalizeMaskKeyframes(item?.keyframes),
        trackingStatus: ['idle', 'tracked', 'partial', 'failed'].includes(item?.trackingStatus)
            ? item.trackingStatus
            : 'idle',
    }));
}

function normalizeSpeed(input = {}) {
    const keyframes = (Array.isArray(input?.keyframes) ? input.keyframes : []).slice(0, 200).map((item, index) => ({
        id: id(item?.id, `speed-${index + 1}`),
        sourceTime: number(item?.sourceTime, 0, 0, MAX_SEQUENCE_DURATION),
        speed: number(item?.speed, 1, 0.05, 16),
    })).sort((left, right) => left.sourceTime - right.sourceTime);
    return {
        rate: number(input?.rate, 1, 0.05, 16),
        reverse: input?.reverse === true,
        freeze: input?.freeze === true,
        freezeAt: number(input?.freezeAt, 0, 0, MAX_SEQUENCE_DURATION),
        opticalFlow: input?.opticalFlow === true,
        pitchPreserve: input?.pitchPreserve !== false,
        keyframes,
    };
}

function normalizeClip(input, index, trackKind, bounds) {
    const sourceType = ['program', 'asset', 'sequence', 'generator'].includes(input?.sourceType)
        ? input.sourceType
        : (input?.assetId ? 'asset' : 'program');
    const sourceStart = number(input?.sourceStart, bounds.start, 0, MAX_SEQUENCE_DURATION);
    const sourceEnd = number(
        input?.sourceEnd,
        Math.min(bounds.end, sourceStart + 5),
        sourceStart + 0.02,
        MAX_SEQUENCE_DURATION,
    );
    const speed = normalizeSpeed(input?.speed);
    const timelineStart = number(input?.timelineStart, 0, 0, MAX_SEQUENCE_DURATION);
    const expectedDuration = Math.max(0.02, (sourceEnd - sourceStart) / speed.rate);
    const timelineEnd = number(
        input?.timelineEnd,
        timelineStart + expectedDuration,
        timelineStart + 0.02,
        MAX_SEQUENCE_DURATION,
    );
    const fitModes = new Set(['cover', 'contain', 'stretch', 'native']);
    return {
        id: id(input?.id, `clip-${index + 1}`),
        name: text(input?.name, sourceType === 'program' ? 'Program source' : `Clip ${index + 1}`, 120),
        enabled: input?.enabled !== false,
        sourceType,
        assetId: input?.assetId ? text(input.assetId, '', 240) : null,
        nestedSequenceId: input?.nestedSequenceId ? id(input.nestedSequenceId, '') : null,
        generator: ['solid', 'color_bars', 'transparent'].includes(input?.generator)
            ? input.generator
            : 'solid',
        generatorColor: color(input?.generatorColor, '#111827'),
        sourceStart,
        sourceEnd,
        timelineStart,
        timelineEnd,
        includeAudio: trackKind === 'video' && input?.includeAudio === true,
        linkedGroupId: input?.linkedGroupId ? id(input.linkedGroupId, '') : null,
        compoundId: input?.compoundId ? id(input.compoundId, '') : null,
        fit: fitModes.has(input?.fit) ? input.fit : 'cover',
        x: number(input?.x, 0, -1, 1),
        y: number(input?.y, 0, -1, 1),
        scale: number(input?.scale, 1, 0.05, 8),
        rotation: number(input?.rotation, 0, -360, 360),
        opacity: number(input?.opacity, 1, 0, 1),
        volumeDb: number(input?.volumeDb, 0, -60, 24),
        fadeIn: number(input?.fadeIn, 0, 0, 10),
        fadeOut: number(input?.fadeOut, 0, 0, 10),
        transitionIn: {
            type: ['cut', 'dissolve', 'fade_black', 'fade_white', 'wipe_left', 'slide_left'].includes(input?.transitionIn?.type)
                ? input.transitionIn.type
                : 'cut',
            duration: number(input?.transitionIn?.duration, 0, 0, 3),
        },
        transitionOut: {
            type: ['cut', 'dissolve', 'fade_black', 'fade_white', 'wipe_left', 'slide_left'].includes(input?.transitionOut?.type)
                ? input.transitionOut.type
                : 'cut',
            duration: number(input?.transitionOut?.duration, 0, 0, 3),
        },
        speed,
        stabilization: {
            enabled: input?.stabilization?.enabled === true,
            strength: number(input?.stabilization?.strength, 12, 1, 64),
            rollingShutter: number(input?.stabilization?.rollingShutter, 0, 0, 1),
            method: input?.stabilization?.method === 'two_pass' ? 'two_pass' : 'realtime',
        },
        chromaKey: {
            enabled: input?.chromaKey?.enabled === true,
            color: color(input?.chromaKey?.color, '#00FF00'),
            similarity: number(input?.chromaKey?.similarity, 0.18, 0.01, 1),
            blend: number(input?.chromaKey?.blend, 0.08, 0, 1),
            spill: number(input?.chromaKey?.spill, 0.25, 0, 1),
            autoBackground: input?.chromaKey?.autoBackground === true,
        },
        masks: normalizeMasks(input?.masks),
        templateIds: (Array.isArray(input?.templateIds) ? input.templateIds : [])
            .slice(0, 32)
            .map((templateId) => id(templateId, ''))
            .filter(Boolean),
        notes: text(input?.notes, '', 500),
    };
}

function normalizeTrack(input, index, bounds) {
    const kind = input?.kind === 'audio' ? 'audio' : 'video';
    return {
        id: id(input?.id, `${kind === 'video' ? 'v' : 'a'}${index + 1}`),
        name: text(input?.name, `${kind === 'video' ? 'Video' : 'Audio'} ${index + 1}`, 80),
        kind,
        order: number(input?.order, index, 0, 1000),
        locked: input?.locked === true,
        hidden: input?.hidden === true,
        muted: input?.muted === true,
        solo: input?.solo === true,
        linked: input?.linked !== false,
        volumeDb: number(input?.volumeDb, 0, -60, 24),
        clips: (Array.isArray(input?.clips) ? input.clips : [])
            .slice(0, 2000)
            .map((clip, clipIndex) => normalizeClip(clip, clipIndex, kind, bounds))
            .sort((left, right) => left.timelineStart - right.timelineStart),
    };
}

function defaultSequence(bounds) {
    return {
        id: 'sequence-main',
        name: 'Main sequence',
        frameRate: DEFAULT_FRAME_RATE,
        width: 1920,
        height: 1080,
        tracks: [
            normalizeTrack({ id: 'v1', name: 'Video 1', kind: 'video', order: 0, clips: [] }, 0, bounds),
            normalizeTrack({ id: 'a1', name: 'Audio 1', kind: 'audio', order: 1, clips: [] }, 1, bounds),
        ],
    };
}

function normalizeSequenceState(input, fallback, bounds) {
    const source = {
        ...(fallback && typeof fallback === 'object' ? fallback : {}),
        ...(input && typeof input === 'object' ? input : {}),
    };
    const sourceSequences = Array.isArray(source.sequences) && source.sequences.length
        ? source.sequences
        : [defaultSequence(bounds)];
    const sequences = sourceSequences.slice(0, 64).map((sequence, sequenceIndex) => {
        const tracks = (Array.isArray(sequence?.tracks) ? sequence.tracks : [])
            .slice(0, 64)
            .map((track, trackIndex) => normalizeTrack(track, trackIndex, bounds))
            .sort((left, right) => left.order - right.order);
        return {
            id: id(sequence?.id, `sequence-${sequenceIndex + 1}`),
            name: text(sequence?.name, `Sequence ${sequenceIndex + 1}`, 100),
            frameRate: number(sequence?.frameRate, DEFAULT_FRAME_RATE, 1, 120),
            width: Math.round(number(sequence?.width, 1920, 64, 8192)),
            height: Math.round(number(sequence?.height, 1080, 64, 8192)),
            tracks: tracks.length ? tracks : defaultSequence(bounds).tracks,
        };
    });
    const sequenceIds = new Set(sequences.map((sequence) => sequence.id));
    return {
        enabled: source.enabled === true,
        mode: source.mode === 'replace' ? 'replace' : 'composite',
        activeSequenceId: sequenceIds.has(source.activeSequenceId)
            ? source.activeSequenceId
            : sequences[0].id,
        sourceIn: source.sourceIn === null || source.sourceIn === undefined
            ? null
            : number(source.sourceIn, bounds.start, bounds.start, bounds.end),
        sourceOut: source.sourceOut === null || source.sourceOut === undefined
            ? null
            : number(source.sourceOut, bounds.end, bounds.start, bounds.end),
        sequences,
        markers: (Array.isArray(source.markers) ? source.markers : []).slice(0, 2000).map((marker, index) => ({
            id: id(marker?.id, `marker-${index + 1}`),
            time: number(marker?.time, 0, 0, MAX_SEQUENCE_DURATION),
            label: text(marker?.label, `Marker ${index + 1}`, 160),
            color: color(marker?.color, '#F59E0B'),
            source: ['manual', 'review', 'qc', 'chapter'].includes(marker?.source) ? marker.source : 'manual',
            resolved: marker?.resolved === true,
        })).sort((left, right) => left.time - right.time),
    };
}

function normalizeColorWorkflow(input, fallback, activeGrade) {
    const source = {
        ...(fallback && typeof fallback === 'object' ? fallback : {}),
        ...(input && typeof input === 'object' ? input : {}),
    };
    const versions = (Array.isArray(source.versions) ? source.versions : []).slice(-100).map((version, index) => ({
        id: id(version?.id, `grade-${index + 1}`),
        name: text(version?.name, `Grade ${index + 1}`, 100),
        createdAt: text(version?.createdAt, new Date(0).toISOString(), 64),
        source: ['manual', 'auto', 'lut', 'match'].includes(version?.source) ? version.source : 'manual',
        grade: normalizeGrade(version?.grade, activeGrade),
        metrics: version?.metrics && typeof version.metrics === 'object' ? version.metrics : {},
    }));
    const versionIds = new Set(versions.map((version) => version.id));
    const inputSpaces = new Set(['auto', 'rec709', 'log_c', 'slog3', 'vlog', 'hlg', 'pq']);
    const workingSpaces = new Set(['rec709', 'acescct', 'hdr10', 'hlg']);
    const outputSpaces = new Set(['rec709', 'hdr10', 'hlg']);
    return {
        management: {
            inputSpace: inputSpaces.has(source.management?.inputSpace) ? source.management.inputSpace : 'auto',
            workingSpace: workingSpaces.has(source.management?.workingSpace) ? source.management.workingSpace : 'rec709',
            outputSpace: outputSpaces.has(source.management?.outputSpace) ? source.management.outputSpace : 'rec709',
            toneMap: ['none', 'hable', 'mobius', 'reinhard'].includes(source.management?.toneMap)
                ? source.management.toneMap
                : 'mobius',
            legalize: source.management?.legalize === true,
            peakNits: number(source.management?.peakNits, 1000, 100, 10000),
        },
        autoGrade: {
            strength: number(source.autoGrade?.strength, 1, 0, 1),
            analyzedAt: source.autoGrade?.analyzedAt ? text(source.autoGrade.analyzedAt, '', 64) : null,
            metrics: source.autoGrade?.metrics && typeof source.autoGrade.metrics === 'object'
                ? source.autoGrade.metrics
                : {},
            confidence: number(source.autoGrade?.confidence, 0, 0, 1),
        },
        versions,
        selectedVersionId: versionIds.has(source.selectedVersionId) ? source.selectedVersionId : null,
        compareVersionId: versionIds.has(source.compareVersionId) ? source.compareVersionId : null,
        groups: (Array.isArray(source.groups) ? source.groups : []).slice(0, 100).map((group, index) => ({
            id: id(group?.id, `color-group-${index + 1}`),
            name: text(group?.name, `Color group ${index + 1}`, 100),
            clipIds: (Array.isArray(group?.clipIds) ? group.clipIds : []).slice(0, 1000).map((clipId) => id(clipId, '')).filter(Boolean),
            grade: normalizeGrade(group?.grade),
        })),
    };
}

function normalizeAdr(input, fallback) {
    const source = {
        ...(fallback && typeof fallback === 'object' ? fallback : {}),
        ...(input && typeof input === 'object' ? input : {}),
    };
    return {
        inputDeviceId: text(source.inputDeviceId, '', 240),
        latencyMs: number(source.latencyMs, 0, -2000, 2000),
        countdownSec: number(source.countdownSec, 3, 0, 10),
        preRollSec: number(source.preRollSec, 2, 0, 10),
        loopRecord: source.loopRecord === true,
        cues: (Array.isArray(source.cues) ? source.cues : []).slice(0, 500).map((cue, index) => ({
            id: id(cue?.id, `adr-cue-${index + 1}`),
            name: text(cue?.name, `ADR cue ${index + 1}`, 100),
            start: number(cue?.start, 0, 0, MAX_SEQUENCE_DURATION),
            end: number(cue?.end, 3, 0.02, MAX_SEQUENCE_DURATION),
            text: text(cue?.text, '', 1000),
            takeAssetIds: (Array.isArray(cue?.takeAssetIds) ? cue.takeAssetIds : []).slice(0, 50).map((assetId) => text(assetId, '', 240)),
            selectedTakeAssetId: cue?.selectedTakeAssetId ? text(cue.selectedTakeAssetId, '', 240) : null,
            roomToneAssetId: cue?.roomToneAssetId ? text(cue.roomToneAssetId, '', 240) : null,
        })).sort((left, right) => left.start - right.start),
    };
}

function normalizePublish(input, fallback) {
    const source = {
        ...(fallback && typeof fallback === 'object' ? fallback : {}),
        ...(input && typeof input === 'object' ? input : {}),
    };
    return {
        title: text(source.title, '', 180),
        description: text(source.description, '', 5000),
        includeMaster: source.includeMaster !== false,
        includeHorizontal: source.includeHorizontal !== false,
        includeSquare: source.includeSquare !== false,
        includeVertical: source.includeVertical !== false,
        includeShorts: source.includeShorts !== false,
        shortsCount: Math.round(number(source.shortsCount, 3, 0, 12)),
        shortDurationSec: number(source.shortDurationSec, 45, 10, 180),
        destinations: (Array.isArray(source.destinations) ? source.destinations : ['youtube'])
            .slice(0, 20)
            .map((destination) => text(destination, '', 60))
            .filter(Boolean),
        chapterArt: source.chapterArt !== false,
        thumbnails: source.thumbnails !== false,
        captions: source.captions !== false,
    };
}

function normalizeLongformProfessional(input, fallback, context = {}) {
    const provided = input && typeof input === 'object' ? input : {};
    const prior = fallback && typeof fallback === 'object' ? fallback : {};
    const start = number(context.start, 0, 0, MAX_SEQUENCE_DURATION);
    const end = number(context.end, Math.max(start + 0.02, context.duration || start + 60), start + 0.02, MAX_SEQUENCE_DURATION);
    const bounds = { start, end };
    const activeGrade = normalizeGrade(provided.color, prior.color);
    return {
        sequence: normalizeSequenceState(provided.sequence, prior.sequence, bounds),
        colorWorkflow: normalizeColorWorkflow(provided.colorWorkflow, prior.colorWorkflow, activeGrade),
        adr: normalizeAdr(provided.adr, prior.adr),
        publish: normalizePublish(provided.publish, prior.publish),
    };
}

function flattenSequenceForRender(sequenceState, context = {}) {
    if (!sequenceState?.enabled) return { enabled: false, mode: 'composite', tracks: [] };
    const sequences = new Map((sequenceState.sequences || []).map((sequence) => [sequence.id, sequence]));
    const active = sequences.get(sequenceState.activeSequenceId) || sequenceState.sequences?.[0];
    if (!active) return { enabled: false, mode: 'composite', tracks: [] };

    function resolveClip(clip, track, offset, ancestry) {
        if (clip.sourceType !== 'sequence') {
            let clipPath = null;
            if (clip.sourceType === 'program') clipPath = context.sourcePath || null;
            if (clip.sourceType === 'asset' && clip.assetId) clipPath = context.resolveAsset?.(clip.assetId) || null;
            return [{ ...clip, timelineStart: clip.timelineStart + offset, timelineEnd: clip.timelineEnd + offset, path: clipPath }];
        }
        const nested = sequences.get(clip.nestedSequenceId);
        if (!nested || ancestry.has(nested.id)) return [];
        const nestedClips = [];
        const nextAncestry = new Set(ancestry);
        nextAncestry.add(nested.id);
        for (const nestedTrack of nested.tracks || []) {
            if (nestedTrack.kind !== track.kind) continue;
            for (const nestedClip of nestedTrack.clips || []) {
                nestedClips.push(...resolveClip(nestedClip, nestedTrack, offset + clip.timelineStart, nextAncestry));
            }
        }
        return nestedClips;
    }

    const tracks = (active.tracks || []).map((track) => ({
        ...track,
        clips: (track.clips || []).flatMap((clip) => resolveClip(clip, track, 0, new Set([active.id]))),
    }));
    return {
        enabled: true,
        mode: sequenceState.mode === 'replace' ? 'replace' : 'composite',
        frameRate: active.frameRate || DEFAULT_FRAME_RATE,
        width: active.width || 1920,
        height: active.height || 1080,
        tracks,
        markers: sequenceState.markers || [],
    };
}

function sequenceTimelineItems(sequenceState, context = {}) {
    const flattened = flattenSequenceForRender(sequenceState, context);
    const videoTracks = flattened.tracks.filter((track) => track.kind === 'video' && !track.hidden);
    const anySolo = videoTracks.some((track) => track.solo);
    const clips = videoTracks
        .filter((track) => !anySolo || track.solo)
        .flatMap((track) => track.clips.map((clip) => ({ ...clip, trackName: track.name, trackOrder: track.order })))
        .filter((clip) => clip.enabled !== false && (clip.path || clip.sourceType === 'generator'))
        .sort((left, right) => left.timelineStart - right.timelineStart || left.trackOrder - right.trackOrder);
    if (clips.length) return clips;
    return (context.segments || []).map(([sourceStart, sourceEnd], index) => ({
        id: `program-${index + 1}`,
        name: context.projectName || 'Program',
        sourceType: 'program',
        path: context.sourcePath,
        sourceStart,
        sourceEnd,
        timelineStart: (context.segments || []).slice(0, index).reduce((sum, item) => sum + item[1] - item[0], 0),
        timelineEnd: (context.segments || []).slice(0, index + 1).reduce((sum, item) => sum + item[1] - item[0], 0),
        trackName: 'V1',
        trackOrder: 0,
        speed: { rate: 1, reverse: false, freeze: false, opticalFlow: false, pitchPreserve: true, keyframes: [] },
    }));
}

function frames(seconds, rate) {
    return Math.max(0, Math.round(number(seconds, 0) * rate));
}

function timecode(seconds, rate = DEFAULT_FRAME_RATE) {
    const totalFrames = frames(seconds, rate);
    const fps = Math.max(1, Math.round(rate));
    const frame = totalFrames % fps;
    const totalSeconds = Math.floor(totalFrames / fps);
    const secs = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    return [hours, minutes, secs, frame].map((value) => String(value).padStart(2, '0')).join(':');
}

function reelName(index) {
    return `AX${String(index + 1).padStart(3, '0')}`.slice(0, 8);
}

function buildLongformEdl(items, options = {}) {
    const rate = number(options.frameRate, DEFAULT_FRAME_RATE, 1, 120);
    const title = text(options.title, 'Viral Clip Factory Sequence', 80);
    const rows = [`TITLE: ${title}`, 'FCM: NON-DROP FRAME', ''];
    items.forEach((item, index) => {
        rows.push(
            `${String(index + 1).padStart(3, '0')}  ${reelName(index).padEnd(8)} V     C        `
            + `${timecode(item.sourceStart, rate)} ${timecode(item.sourceEnd, rate)} `
            + `${timecode(item.timelineStart, rate)} ${timecode(item.timelineEnd, rate)}`,
        );
        rows.push(`* FROM CLIP NAME: ${text(item.name || path.basename(item.path || ''), `Clip ${index + 1}`, 180)}`);
        if (item.path) rows.push(`* SOURCE FILE: ${item.path}`);
        if (item.speed?.reverse) rows.push('* EFFECT: REVERSE');
        if (Math.abs(number(item.speed?.rate, 1) - 1) > 0.0001) rows.push(`* SPEED: ${number(item.speed?.rate, 1).toFixed(4)}x`);
        rows.push('');
    });
    return `${rows.join('\n')}\n`;
}

function otioRational(seconds, rate) {
    return { 'OTIO_SCHEMA': 'RationalTime.1', value: frames(seconds, rate), rate };
}

function buildLongformOtio(items, options = {}) {
    const rate = number(options.frameRate, DEFAULT_FRAME_RATE, 1, 120);
    const children = [];
    let cursor = 0;
    items.forEach((item, index) => {
        if (item.timelineStart > cursor + 0.001) {
            children.push({
                OTIO_SCHEMA: 'Gap.1',
                name: 'Gap',
                source_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: otioRational(0, rate),
                    duration: otioRational(item.timelineStart - cursor, rate),
                },
                effects: [],
                markers: [],
                metadata: {},
            });
        }
        const duration = Math.max(0.02, item.timelineEnd - item.timelineStart);
        children.push({
            OTIO_SCHEMA: 'Clip.2',
            name: text(item.name, `Clip ${index + 1}`, 180),
            source_range: {
                OTIO_SCHEMA: 'TimeRange.1',
                start_time: otioRational(item.sourceStart, rate),
                duration: otioRational(duration, rate),
            },
            media_reference: item.path ? {
                OTIO_SCHEMA: 'ExternalReference.1',
                name: path.basename(item.path),
                target_url: `file://${item.path}`,
                available_range: null,
                metadata: {},
            } : {
                OTIO_SCHEMA: 'MissingReference.1',
                name: 'Offline media',
                available_range: null,
                metadata: {},
            },
            effects: [],
            markers: [],
            metadata: {
                track: item.trackName,
                speed: item.speed || {},
                viral_clip_factory_id: item.id,
            },
        });
        cursor = Math.max(cursor, item.timelineEnd);
    });
    return JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        name: text(options.title, 'Viral Clip Factory Sequence', 180),
        global_start_time: otioRational(0, rate),
        tracks: {
            OTIO_SCHEMA: 'Stack.1',
            name: 'Tracks',
            source_range: null,
            effects: [],
            markers: [],
            metadata: {},
            children: [{
                OTIO_SCHEMA: 'Track.1',
                name: 'V1',
                kind: 'Video',
                source_range: null,
                effects: [],
                markers: [],
                metadata: {},
                children,
            }],
        },
        metadata: {
            application: 'Viral Clip Factory',
            interchangeVersion: 1,
        },
    }, null, 2);
}

function xml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildLongformFcpxml(items, options = {}) {
    const rate = number(options.frameRate, DEFAULT_FRAME_RATE, 1, 120);
    const frameDuration = `${Math.max(1, Math.round(1000 / rate))}/1000s`;
    const resources = items.map((item, index) => (
        `<asset id="r${index + 2}" name="${xml(item.name || `Clip ${index + 1}`)}" `
        + `src="${xml(item.path ? `file://${item.path}` : '')}" start="0s" duration="${Math.max(0.02, item.sourceEnd - item.sourceStart).toFixed(3)}s" hasVideo="1" hasAudio="${item.includeAudio ? 1 : 0}"/>`
    )).join('\n    ');
    const clips = items.map((item, index) => (
        `<asset-clip ref="r${index + 2}" name="${xml(item.name || `Clip ${index + 1}`)}" `
        + `offset="${item.timelineStart.toFixed(3)}s" start="${item.sourceStart.toFixed(3)}s" `
        + `duration="${Math.max(0.02, item.timelineEnd - item.timelineStart).toFixed(3)}s" lane="${Math.max(0, item.trackOrder || 0)}"/>`
    )).join('\n            ');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat1080p${Math.round(rate)}" frameDuration="${frameDuration}" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>
    ${resources}
  </resources>
  <library>
    <event name="${xml(options.title || 'Viral Clip Factory')}">
      <project name="${xml(options.title || 'Sequence')}">
        <sequence format="r1" duration="${Math.max(0.02, ...items.map((item) => item.timelineEnd)).toFixed(3)}s" tcStart="0s" tcFormat="NDF">
          <spine>
            ${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

function interchangeDigest(items, options = {}) {
    return crypto.createHash('sha256')
        .update(JSON.stringify({ items, options }))
        .digest('hex');
}

function supplementQcReport(report, creative, context = {}) {
    const issues = Array.isArray(report?.issues) ? report.issues.map((issue) => ({ ...issue })) : [];
    const captions = creative?.captions?.cues || [];
    for (let index = 1; index < captions.length; index += 1) {
        if (captions[index].start < captions[index - 1].end - 0.001) {
            issues.push({
                id: `caption-overlap-${index}`,
                severity: 'warning',
                category: 'captions',
                time: captions[index].start,
                title: 'Caption overlap',
                detail: `Caption ${index + 1} overlaps the previous cue.`,
            });
        }
    }
    captions.forEach((cue, index) => {
        const duration = Math.max(0.05, cue.end - cue.start);
        const readingSpeed = String(cue.text || '').length / duration;
        if (readingSpeed > 20) {
            issues.push({
                id: `caption-speed-${index}`,
                severity: readingSpeed > 28 ? 'error' : 'warning',
                category: 'captions',
                time: cue.start,
                title: 'Caption reading speed',
                detail: `${readingSpeed.toFixed(1)} characters/second is difficult to read.`,
            });
        }
    });
    const flattened = flattenSequenceForRender(creative?.sequence, context);
    flattened.tracks.forEach((track) => {
        track.clips.forEach((clip) => {
            if (clip.sourceType === 'asset' && !clip.path) {
                issues.push({
                    id: `missing-${clip.id}`,
                    severity: 'error',
                    category: 'media',
                    time: clip.timelineStart,
                    title: 'Missing media',
                    detail: `${clip.name} is offline or has been moved.`,
                });
            }
        });
    });
    if (!(context.chapters || []).length) {
        issues.push({
            id: 'missing-chapters',
            severity: 'info',
            category: 'delivery',
            time: 0,
            title: 'No chapters',
            detail: 'Add chapters for navigation and chapter-art generation.',
        });
    }
    if (!creative?.publish?.title) {
        issues.push({
            id: 'missing-publish-title',
            severity: 'warning',
            category: 'delivery',
            time: 0,
            title: 'Missing delivery title',
            detail: 'The publish package does not have a title yet.',
        });
    }
    const counts = issues.reduce((summary, issue) => {
        summary[issue.severity] = (summary[issue.severity] || 0) + 1;
        return summary;
    }, { error: 0, warning: 0, info: 0 });
    return {
        ...(report || {}),
        generatedAt: report?.generatedAt || new Date().toISOString(),
        issues: issues.sort((left, right) => number(left.time, 0) - number(right.time, 0)),
        summary: {
            ...(report?.summary || {}),
            ...counts,
            passed: counts.error === 0,
        },
    };
}

function normalizeEffectTemplate(input, fallbackId) {
    const category = ['transition', 'title', 'effect', 'color', 'audio', 'mask'].includes(input?.category)
        ? input.category
        : 'effect';
    return {
        id: id(input?.id, fallbackId),
        name: text(input?.name, 'Untitled template', 120),
        category,
        description: text(input?.description, '', 500),
        version: Math.round(number(input?.version, 1, 1, 10000)),
        controls: (Array.isArray(input?.controls) ? input.controls : []).slice(0, 100).map((control, index) => ({
            id: id(control?.id, `control-${index + 1}`),
            label: text(control?.label, `Control ${index + 1}`, 80),
            type: ['number', 'color', 'boolean', 'select', 'text'].includes(control?.type) ? control.type : 'number',
            value: control?.value ?? 0,
            min: number(control?.min, 0),
            max: number(control?.max, 1),
            step: number(control?.step, 0.01, 0.000001),
            options: (Array.isArray(control?.options) ? control.options : []).slice(0, 100).map((option) => text(option, '', 80)),
        })),
        payload: input?.payload && typeof input.payload === 'object' ? input.payload : {},
        createdAt: text(input?.createdAt, new Date().toISOString(), 64),
    };
}

module.exports = {
    buildLongformEdl,
    buildLongformFcpxml,
    buildLongformOtio,
    flattenSequenceForRender,
    interchangeDigest,
    normalizeEffectTemplate,
    normalizeGrade,
    normalizeLongformProfessional,
    sequenceTimelineItems,
    supplementQcReport,
    timecode,
};
