import types
import unittest
from unittest.mock import patch

import hardware_accel


def fake_torch(*, available=False, hip=None, cuda=None, name="Test GPU"):
    return types.SimpleNamespace(
        version=types.SimpleNamespace(hip=hip, cuda=cuda),
        cuda=types.SimpleNamespace(
            is_available=lambda: available,
            get_device_name=lambda _: name,
        ),
    )


class ComputeDetectionTests(unittest.TestCase):
    def test_rocm_uses_cuda_device_string(self):
        torch = fake_torch(available=True, hip="7.13", name="Radeon 8060S")
        device, backend = hardware_accel.select_compute_device("auto", torch)
        self.assertEqual((device, backend), ("cuda", "rocm"))

    def test_cuda_is_preserved(self):
        torch = fake_torch(available=True, cuda="13.0", name="NVIDIA GPU")
        device, backend = hardware_accel.select_compute_device("auto", torch)
        self.assertEqual((device, backend), ("cuda", "cuda"))

    def test_requested_missing_backend_fails_clearly(self):
        with self.assertRaisesRegex(RuntimeError, "rocm"):
            hardware_accel.select_compute_device("rocm", fake_torch())

    def test_disabled_gpu_forces_cpu(self):
        torch = fake_torch(available=True, hip="7.13")
        self.assertEqual(hardware_accel.select_compute_device("auto", torch, False), ("cpu", "cpu"))


class EncoderCommandTests(unittest.TestCase):
    def test_vaapi_upload_filter_is_appended(self):
        self.assertEqual(
            hardware_accel.encoder_filter("scale=1080:1920", "vaapi"),
            "scale=1080:1920,format=nv12,hwupload",
        )

    def test_hdr_uses_hevc_main10(self):
        args = hardware_accel.encoder_args("vaapi", is_hdr=True)
        self.assertIn("hevc_vaapi", args)
        self.assertIn("main10", args)

    @patch("hardware_accel.platform.system", return_value="Windows")
    def test_windows_auto_prefers_amf(self, _):
        self.assertEqual(hardware_accel.video_backend_order("auto"), ["amf", "vaapi", "nvenc", "cpu"])

    @patch("hardware_accel.platform.system", return_value="Linux")
    def test_linux_auto_prefers_vaapi(self, _):
        self.assertEqual(hardware_accel.video_backend_order("auto"), ["vaapi", "nvenc", "amf", "cpu"])


if __name__ == "__main__":
    unittest.main()
