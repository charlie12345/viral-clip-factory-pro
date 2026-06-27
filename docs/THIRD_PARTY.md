# Third-Party Components

This file is practical release documentation, not legal advice.

## Not Bundled

Users are expected to install or obtain these separately:

- Node.js
- Python
- `ffmpeg`
- PyTorch runtime
- Whisper model downloads
- optional CUDA/NVIDIA drivers
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

## Important Notes

- The current implementation imports Ultralytics YOLO directly. That is the main reason this clean repo defaults to an `AGPL-3.0-only` project license for now.
- `ffmpeg` is an external binary. If you distribute your own packaged binary later, review its exact build configuration and licensing obligations.
- The clean repo intentionally excludes personal credentials, local media, local model weights, runtime logs, and generated outputs.
- The clean repo also excludes the Microsoft-style Office font files that existed in the working environment.

## Reference Links

- Whisper: https://github.com/openai/whisper
- face_recognition: https://github.com/ageitgey/face_recognition
- FFmpeg legal page: https://ffmpeg.org/legal.html
- Ultralytics license: https://www.ultralytics.com/license
- OpenCV license: https://opencv.org/license/
- PyTorch repository: https://github.com/pytorch/pytorch
