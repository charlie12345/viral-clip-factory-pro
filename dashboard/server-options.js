const crypto = require('crypto');
const path = require('path');

function sanitizeUploadFilename(fileName) {
    const rawName = path.basename(String(fileName || 'upload.mp4')).trim() || 'upload.mp4';
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return safeName || `upload_${Date.now()}.mp4`;
}

function uniqueUploadFilename(fileName, now = Date.now(), randomBytes = crypto.randomBytes) {
    const safeName = sanitizeUploadFilename(fileName);
    const extension = path.extname(safeName);
    const stem = path.basename(safeName, extension);
    const suffix = `${now}-${randomBytes(3).toString('hex')}`;
    return `${stem.slice(0, 140)}-${suffix}${extension}`;
}

function normalizeBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function normalizeUploadOptions(input = {}, env = process.env) {
    const mode = String(input.mode || 'shorts') === 'longform' ? 'longform' : 'shorts';
    const upscale = input.upscale === true || String(input.upscale || '').toLowerCase() === 'true';
    const subtitleStyle = typeof input.subtitleStyle === 'string' && input.subtitleStyle.trim()
        ? input.subtitleStyle.trim()
        : 'classic';
    const maxDuration = ['30', '60', '90', '120', '180'].includes(String(input.maxDuration))
        ? String(input.maxDuration)
        : '180';
    const maxClipsNum = Number.parseInt(input.maxClips, 10);
    const maxClips = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50].includes(maxClipsNum)
        ? String(maxClipsNum)
        : '30';
    const clipVolume = ['curated', 'balanced', 'more', 'exact'].includes(String(input.clipVolume))
        ? String(input.clipVolume)
        : 'balanced';
    const targetClipsNum = Number.parseInt(input.targetClips, 10);
    const targetClips = String(Math.min(
        Number.parseInt(maxClips, 10),
        Math.max(1, Number.isFinite(targetClipsNum) ? targetClipsNum : 12),
    ));
    const startTime = input.startTime !== undefined && input.startTime !== null && String(input.startTime).trim() !== ''
        ? String(input.startTime).trim()
        : '';
    const endTime = input.endTime !== undefined && input.endTime !== null && String(input.endTime).trim() !== ''
        ? String(input.endTime).trim()
        : '';
    const framingModeRaw = String(input.framingMode || input.framing_mode || 'auto').trim();
    const framingMode = ['auto', 'smart_switch', 'dual_stack'].includes(framingModeRaw)
        ? framingModeRaw
        : 'auto';
    const computeDevice = ['auto', 'cpu', 'cuda', 'rocm'].includes(String(input.computeDevice))
        ? String(input.computeDevice)
        : 'auto';
    const videoEncoder = ['auto', 'cpu', 'nvenc', 'vaapi', 'amf'].includes(String(input.videoEncoder))
        ? String(input.videoEncoder)
        : 'auto';
    const transcriptionProvider = ['auto', 'openai_whisper', 'whisper_cpp', 'deepgram'].includes(String(input.transcriptionProvider))
        ? String(input.transcriptionProvider)
        : 'auto';
    const transcriptionModel = ['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'].includes(String(input.transcriptionModel))
        ? String(input.transcriptionModel)
        : 'large-v3';
    const transcriptionPreset = ['draft', 'final'].includes(String(input.transcriptionPreset))
        ? String(input.transcriptionPreset)
        : 'final';
    const requestedLanguage = String(input.transcriptionLanguage || 'auto').trim().toLowerCase();
    const transcriptionLanguage = requestedLanguage === 'auto' || /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(requestedLanguage)
        ? requestedLanguage
        : 'auto';
    const localSemantic = normalizeBoolean(input.localSemantic, true);
    // Cloud processing is deliberately opt-in even when a server key exists.
    const geminiAnalysis = normalizeBoolean(input.geminiAnalysis, false);
    const reviewBeforeRender = mode === 'shorts' && normalizeBoolean(input.reviewBeforeRender, false);
    const exportPreset = ['generic', 'youtube_shorts', 'instagram_reels', 'tiktok'].includes(String(input.exportPreset))
        ? String(input.exportPreset)
        : 'generic';
    const outputNameTemplate = typeof input.outputNameTemplate === 'string' && input.outputNameTemplate.trim()
        ? input.outputNameTemplate.trim().slice(0, 200)
        : '{source}_{platform}_{index}_{score}';
    const vaapiDevice = typeof input.vaapiDevice === 'string' && input.vaapiDevice.trim()
        ? input.vaapiDevice.trim().slice(0, 260)
        : (env.VCF_VAAPI_DEVICE || '/dev/dri/renderD128');

    return {
        mode,
        upscale,
        subtitleStyle,
        maxDuration,
        clipVolume,
        targetClips,
        maxClips,
        startTime,
        endTime,
        framingMode,
        computeDevice,
        videoEncoder,
        transcriptionProvider,
        transcriptionModel,
        transcriptionPreset,
        transcriptionLanguage,
        localSemantic,
        geminiAnalysis,
        reviewBeforeRender,
        exportPreset,
        outputNameTemplate,
        vaapiDevice,
    };
}

function mergeUploadOptions(input = {}, serverDefaults = {}, env = process.env) {
    const normalizedDefaults = normalizeUploadOptions(serverDefaults, env);
    const supplied = Object.fromEntries(
        Object.entries(input || {}).filter(([, value]) => value !== undefined && value !== null),
    );
    return normalizeUploadOptions({ ...normalizedDefaults, ...supplied }, env);
}

function capabilityById(items, key, id) {
    return (Array.isArray(items) ? items : []).find((item) => item && item[key] === id) || null;
}

function firstAvailable(items, key, preferred) {
    const list = Array.isArray(items) ? items : [];
    const preferredItem = preferred ? capabilityById(list, key, preferred) : null;
    if (preferredItem?.available) return preferredItem;
    return list.find((item) => item?.available) || null;
}

function warning(code, message, requested, fallback = null) {
    return { code, message, requested, fallback };
}

function buildJobPreflight(options = {}, capabilities = {}) {
    const requested = normalizeUploadOptions(options);
    const warnings = [];
    const errors = [];

    const compute = Array.isArray(capabilities.compute) ? capabilities.compute : [];
    const requestedCompute = capabilityById(compute, 'backend', requested.computeDevice);
    const recommendedCompute = firstAvailable(compute, 'backend', capabilities.recommendedCompute)
        || { backend: 'cpu', available: true };
    let effectiveCompute = requested.computeDevice;
    if (requested.computeDevice === 'auto') {
        effectiveCompute = recommendedCompute.backend;
    } else if (!requestedCompute?.available) {
        const reason = requestedCompute?.reason ? `: ${requestedCompute.reason}` : '';
        errors.push({
            code: 'compute_unavailable',
            message: `Requested compute backend ${requested.computeDevice} is unavailable${reason}`,
            requested: requested.computeDevice,
            fallback: null,
        });
    }

    const encoders = Array.isArray(capabilities.videoEncoders) ? capabilities.videoEncoders : [];
    const requestedEncoder = capabilityById(encoders, 'backend', requested.videoEncoder);
    const recommendedEncoder = firstAvailable(encoders, 'backend', capabilities.recommendedVideoEncoder)
        || { backend: 'cpu', available: true };
    let effectiveEncoder = requested.videoEncoder;
    if (requested.videoEncoder === 'auto') {
        effectiveEncoder = recommendedEncoder.backend;
    } else if (!requestedEncoder?.available) {
        effectiveEncoder = recommendedEncoder.backend;
        const reason = requestedEncoder?.reason ? `: ${requestedEncoder.reason}` : '';
        warnings.push(warning(
            'video_encoder_fallback',
            `Requested video encoder ${requested.videoEncoder} is unavailable${reason}; rendering will fall back to ${effectiveEncoder}`,
            requested.videoEncoder,
            effectiveEncoder,
        ));
    }

    const providers = Array.isArray(capabilities.transcriptionProviders)
        ? capabilities.transcriptionProviders
        : [];
    const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
    const localOrder = ['rocm', 'cuda'].includes(effectiveCompute)
        ? ['openai_whisper', 'whisper_cpp']
        : ['whisper_cpp', 'openai_whisper'];
    const firstLocal = localOrder.map((id) => providerMap.get(id)).find((provider) => provider?.available) || null;
    const requestedProvider = providerMap.get(requested.transcriptionProvider);
    let effectiveProvider = requested.transcriptionProvider;
    if (requested.transcriptionProvider === 'auto') {
        effectiveProvider = firstLocal?.id || null;
    } else if (!requestedProvider?.available) {
        effectiveProvider = firstLocal?.id || null;
        const reason = requestedProvider?.reason ? `: ${requestedProvider.reason}` : '';
        warnings.push(warning(
            'transcription_provider_fallback',
            `Requested transcription provider ${requested.transcriptionProvider} is unavailable${reason}${effectiveProvider ? `; transcription will fall back to ${effectiveProvider}` : ''}`,
            requested.transcriptionProvider,
            effectiveProvider,
        ));
    }
    if (!effectiveProvider) {
        errors.push({
            code: 'transcription_unavailable',
            message: 'No usable transcription provider is available',
            requested: requested.transcriptionProvider,
            fallback: null,
        });
    }

    const effectiveProviderCapability = providerMap.get(effectiveProvider);
    let effectiveModel = requested.transcriptionModel;
    if (effectiveProviderCapability?.model) effectiveModel = effectiveProviderCapability.model;
    else if (effectiveProvider === 'deepgram') effectiveModel = 'nova-3';

    const viralProviders = Array.isArray(capabilities.viralProviders) ? capabilities.viralProviders : [];
    const localSemanticCapability = capabilityById(viralProviders, 'id', 'local_semantic');
    const geminiCapability = capabilityById(viralProviders, 'id', 'gemini');
    const effectiveLocalSemantic = Boolean(requested.localSemantic && localSemanticCapability?.available);
    const effectiveGeminiAnalysis = Boolean(requested.geminiAnalysis && geminiCapability?.available);
    if (requested.localSemantic && !effectiveLocalSemantic) {
        const reason = localSemanticCapability?.reason ? `: ${localSemanticCapability.reason}` : '';
        warnings.push(warning(
            'local_semantic_unavailable',
            `Local semantic reranking is selected but unavailable${reason}; heuristic scoring will still run`,
            true,
            false,
        ));
    }
    if (requested.geminiAnalysis && !effectiveGeminiAnalysis) {
        const reason = geminiCapability?.reason ? `: ${geminiCapability.reason}` : '';
        warnings.push(warning(
            'gemini_unavailable',
            `Gemini analysis is selected but unavailable${reason}; local analysis will still run`,
            true,
            false,
        ));
    }

    return {
        ready: errors.length === 0,
        requested: {
            computeDevice: requested.computeDevice,
            videoEncoder: requested.videoEncoder,
            transcriptionProvider: requested.transcriptionProvider,
            transcriptionModel: requested.transcriptionModel,
            transcriptionPreset: requested.transcriptionPreset,
            transcriptionLanguage: requested.transcriptionLanguage,
            localSemantic: requested.localSemantic,
            geminiAnalysis: requested.geminiAnalysis,
            reviewBeforeRender: requested.reviewBeforeRender,
        },
        effective: {
            computeDevice: effectiveCompute,
            videoEncoder: effectiveEncoder,
            transcriptionProvider: effectiveProvider,
            transcriptionModel: effectiveModel,
            transcriptionPreset: requested.transcriptionPreset,
            transcriptionLanguage: requested.transcriptionLanguage,
            localSemantic: effectiveLocalSemantic,
            geminiAnalysis: effectiveGeminiAnalysis,
            reviewBeforeRender: requested.reviewBeforeRender,
        },
        warnings,
        errors,
    };
}

function reconcileRunningJobHistory(jobs, active = {}, now = new Date().toISOString()) {
    let changed = false;
    let interrupted = 0;
    const activeJobId = active.jobId || null;
    const activePid = Number.isInteger(active.pid) && active.pid > 0 ? active.pid : null;
    const next = (Array.isArray(jobs) ? jobs : []).map((job) => {
        if (!job || job.status !== 'running') return job;
        const isStillActive = Boolean(
            (activeJobId && job.id === activeJobId)
            || (activePid && Number(job.pid) === activePid),
        );
        if (isStillActive) return job;
        changed = true;
        interrupted += 1;
        return {
            ...job,
            status: 'interrupted',
            finishedAt: job.finishedAt || now,
            error: job.error || 'Dashboard restarted before this job reported completion',
        };
    });
    return { jobs: next, changed, interrupted };
}

function buildFactoryArgs(scriptPath, uploadPath, options = {}) {
    const normalized = normalizeUploadOptions(options);
    const pipelineMode = normalized.mode === 'shorts' && normalized.reviewBeforeRender
        ? 'shorts-analyze'
        : normalized.mode;
    const args = [scriptPath, uploadPath, '--mode', pipelineMode];
    if (normalized.upscale) args.push('--upscale');
    if (normalized.mode === 'shorts' && normalized.subtitleStyle && normalized.subtitleStyle !== 'none') args.push('--subtitle-style', normalized.subtitleStyle);
    if (normalized.mode === 'shorts' && normalized.maxDuration) args.push('--max-duration', normalized.maxDuration);
    if (normalized.mode === 'shorts') args.push('--clip-volume', normalized.clipVolume);
    if (normalized.mode === 'shorts' && normalized.clipVolume === 'exact') args.push('--target-clips', normalized.targetClips);
    if (normalized.mode === 'shorts' && normalized.maxClips) args.push('--max-clips', normalized.maxClips);
    if (normalized.startTime) args.push('--start-time', normalized.startTime);
    if (normalized.endTime) args.push('--end-time', normalized.endTime);
    if (normalized.mode === 'shorts' && normalized.framingMode) args.push('--framing-mode', normalized.framingMode);
    args.push('--compute-device', normalized.computeDevice);
    args.push('--video-encoder', normalized.videoEncoder);
    args.push('--transcription-provider', normalized.transcriptionProvider);
    args.push('--transcription-model', normalized.transcriptionModel);
    args.push('--transcription-language', normalized.transcriptionLanguage);
    if (normalized.mode === 'shorts' && normalized.localSemantic) args.push('--local-semantic');
    if (normalized.mode === 'shorts' && normalized.geminiAnalysis) args.push('--gemini-analysis');
    args.push('--export-preset', normalized.exportPreset);
    args.push('--output-name-template', normalized.outputNameTemplate);
    if (normalized.vaapiDevice) args.push('--vaapi-device', normalized.vaapiDevice);
    return args;
}

module.exports = {
    buildJobPreflight,
    buildFactoryArgs,
    mergeUploadOptions,
    normalizeUploadOptions,
    reconcileRunningJobHistory,
    sanitizeUploadFilename,
    uniqueUploadFilename,
};
