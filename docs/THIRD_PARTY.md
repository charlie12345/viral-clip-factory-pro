# Third-Party Components

This file is practical release documentation, not legal advice.

## Not Bundled

Users are expected to install or obtain these separately:

- Node.js
- Python
- `ffmpeg`
- PyTorch runtime
- Whisper model downloads
- optional `whisper.cpp` executable, GGML transcription model, and Silero VAD model
- optional ROCm/AMD or CUDA/NVIDIA drivers
- optional YOLO weight files such as `yolov8n.pt`

## Python Libraries Used By The App

- `openai-whisper`
- `torch`
- `opencv-python`
- `numpy`
- `PyYAML`
- `face-recognition`
- `ultralytics`
- `librosa`
- `yt-dlp`
- `pytubefix`

## Important Notes

- The current implementation imports Ultralytics YOLO directly. That is the main reason this clean repo defaults to an `AGPL-3.0-only` project license for now.
- `ffmpeg` is an external binary. If you distribute your own packaged binary later, review its exact build configuration and licensing obligations.
- The clean repo intentionally excludes personal credentials, local media, local model weights, runtime logs, and generated outputs.
- The optional whisper.cpp helper fetches source, transcription weights, and Silero VAD weights from official upstream projects during installation; none are redistributed in this repository.
- The clean repo also excludes the Microsoft-style Office font files that existed in the working environment.
- Deepgram Nova-3 transcription and Gemini video analysis are optional cloud services. They receive media only when the user explicitly enables the corresponding provider for a job.
- An optional semantic reranker calls a separately configured OpenAI-compatible model server. That server and its models are not distributed with this project.
- Provider credentials stay in server-side environment variables; the dashboard receives availability status, not key values. Automatic topics are provider output and do not require user-entered keywords.

## Reference Links

- Whisper: https://github.com/openai/whisper
- whisper.cpp: https://github.com/ggml-org/whisper.cpp
- whisper.cpp VAD models: https://huggingface.co/ggml-org/whisper-vad
- Deepgram Nova-3: https://developers.deepgram.com/docs/models-languages-overview
- Gemini video understanding: https://ai.google.dev/gemini-api/docs/video-understanding
- llama.cpp OpenAI-compatible server: https://github.com/ggml-org/llama.cpp/tree/master/tools/server
- face_recognition: https://github.com/ageitgey/face_recognition
- FFmpeg legal page: https://ffmpeg.org/legal.html
- Ultralytics license: https://www.ultralytics.com/license
- OpenCV license: https://opencv.org/license/
- PyTorch repository: https://github.com/pytorch/pytorch
