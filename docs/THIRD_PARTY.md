# Third-Party Components and Notices

This file records the third-party material present in the source release. It is
practical release documentation, not legal advice.

## Release posture

The application directly imports Ultralytics YOLO, so the project code is
licensed `AGPL-3.0-only`; see [LICENSE](../LICENSE). A network deployment must
offer its users the complete corresponding source for that deployed revision.
See [PUBLISHING.md](PUBLISHING.md) before deploying or redistributing it.

## Bundled fonts

The following unmodified font binaries are committed in `dashboard/public/fonts`
or `webui/public/fonts`. The project AGPL license applies to Viral Clip Factory
code, not to these font files. The full SIL Open Font License 1.1 is included
at [licenses/SIL-OFL-1.1.txt](licenses/SIL-OFL-1.1.txt).

| Font files | Copyright notice / source | License |
| --- | --- | --- |
| `Anton-Regular.ttf` | Copyright 2020 The Anton Project Authors | SIL Open Font License 1.1 |
| `Archivo-Black.ttf` | Copyright 2017 The Archivo Black Project Authors | SIL Open Font License 1.1 |
| `BarlowCondensed-Black.ttf` | Copyright 2017 The Barlow Project Authors | SIL Open Font License 1.1 |
| `BebasNeue-Regular.ttf` | Copyright 2019 The Bebas Neue Project Authors | SIL Open Font License 1.1 |
| `ComicNeue-Bold.ttf` | Copyright 2014 The Comic Neue Project Authors | SIL Open Font License 1.1 |
| `Montserrat-Black.ttf`, `Montserrat-Bold.ttf` | Copyright 2011 The Montserrat Project Authors | SIL Open Font License 1.1 |
| `Oswald-Bold.ttf` | Copyright 2016 The Oswald Project Authors | SIL Open Font License 1.1 |
| `Poppins-Black.ttf`, `Poppins-Bold.ttf` | Copyright 2020 The Poppins Project Authors | SIL Open Font License 1.1 |
| `Rajdhani-Bold.ttf` | Copyright 2014 The Rajdhani Project Authors, Indian Type Foundry | SIL Open Font License 1.1 |
| `LiberationMono-Bold.ttf`, `LiberationSans-Bold.ttf`, `LiberationSerif-Bold.ttf` | Digitized data copyright 2010 Google Corporation; Liberation font design and documentation copyright Red Hat, Inc. | SIL Open Font License 1.1 (Reserved Font Name: Liberation) |
| `inter-var-latin.woff2` | Copyright 2020 The Inter Project Authors | SIL Open Font License 1.1 |
| `DejaVuSans-Bold.ttf`, `DejaVuSerif-Bold.ttf` | Bitstream, Inc. (2003); DejaVu changes in the public domain by Tavmjong Bah (2006) | Bitstream Vera / Arev notices embedded in the original, unmodified font files; see https://dejavu-fonts.github.io/License.html |

Redistributors must preserve the above notices and the applicable font license
when they redistribute these font files. Do not rename or modify OFL fonts in a
way that violates their Reserved Font Name conditions.

## Dependencies installed separately

The source tree does not vendor the following libraries or their license texts;
package managers obtain them with their own metadata and notices. This list is
the direct application dependency inventory, not a replacement for a packaged
distribution's license scan.

| Component | License family | Use |
| --- | --- | --- |
| [Ultralytics YOLO v8.4.91](https://github.com/ultralytics/ultralytics/tree/8fc958ed38c4c4f8b58da9f5f4f24183aa2bbb96) / `ultralytics==8.4.91` | AGPL-3.0 or Enterprise | YOLO person detection and layout analysis |
| `openai-whisper` | MIT | local transcription |
| PyTorch / `torch`, `torchvision` | BSD-style | ML runtime |
| OpenCV | Apache-2.0 | video/image processing |
| NumPy | BSD-style and permissive notices | numeric processing |
| `pyaaf2`, PyYAML, `face-recognition`, `face-recognition-models`, `pytubefix` | MIT | project and media helpers |
| `librosa` | ISC | audio analysis |
| `yt-dlp` | Unlicense | optional source download |
| Node/React/Vite/Express application dependencies | permissive licenses | dashboard and web UI |

The source tree does not vendor Ultralytics. The exact `ultralytics==8.4.91`
release is locked in [requirements.lock.txt](../requirements.lock.txt), and its
upstream source is the immutable commit linked in the table. The dashboard's
legal notice links both to Viral Clip Factory's corresponding source and to
that Ultralytics source.

## Not bundled

Users install or obtain these separately: Node.js, Python, `ffmpeg`, PyTorch
runtime, Whisper model downloads, optional `whisper.cpp` executable and GGML /
Silero VAD models, optional ROCm or CUDA drivers, and YOLO weights such as
`yolov8n.pt`. The clean repository intentionally excludes credentials, local
media, model weights, runtime logs, generated outputs, and Microsoft-style
Office fonts from the working environment.

If you distribute a container, desktop package, `ffmpeg` binary, model weights,
or any other artifact rather than this source tree, produce an artifact-specific
license and notice inventory. `ffmpeg` licensing depends on its build options.

## Services and optional integrations

Deepgram Nova-3 and Gemini video analysis are optional cloud services; they
receive media only when the user enables their provider for a job. An optional
semantic reranker calls a separately configured OpenAI-compatible model server.
Those services, servers, and models are not distributed with this project.

## Reference links

- Whisper: https://github.com/openai/whisper
- whisper.cpp: https://github.com/ggml-org/whisper.cpp
- Whisper VAD models: https://huggingface.co/ggml-org/whisper-vad
- FFmpeg licensing: https://ffmpeg.org/legal.html
- Ultralytics licensing: https://www.ultralytics.com/license
- DejaVu Font License: https://dejavu-fonts.github.io/License.html
- OpenCV license: https://opencv.org/license/
- PyTorch repository: https://github.com/pytorch/pytorch
