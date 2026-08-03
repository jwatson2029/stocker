#!/usr/bin/env python3
"""
Lightweight school-bus detector (no PyTorch — fits small Oracle disks).

Flow: grab HLS frame → motion gate → yellow blob shaped like a bus → Discord.

Env:
  IMAGE_ID, DISCORD_WEBHOOK_URL
  DETECT_INTERVAL_SECS (default 0.1)
  DETECT_COOLDOWN_SECS (default 60)
  DETECT_MOTION_THRESHOLD (default 6)
  DETECT_MIN_AREA (default 0.01)   # fraction of frame
  DETECT_MAX_AREA (default 0.55)
  DETECT_MIN_YELLOW (default 0.25) # yellow fraction inside blob box
  DETECT_WHITE_CARS (default 1)    # temporary white-car alerts
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

import cv2
import numpy as np
import requests

IMAGE_ID = os.environ.get("IMAGE_ID", "19494")
WEBHOOK = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
INTERVAL = max(0.05, float(os.environ.get("DETECT_INTERVAL_SECS", "0.1")))
COOLDOWN = max(15.0, float(os.environ.get("DETECT_COOLDOWN_SECS", "60")))
MOTION_THR = float(os.environ.get("DETECT_MOTION_THRESHOLD", "6"))
MIN_AREA = float(os.environ.get("DETECT_MIN_AREA", "0.01"))
MAX_AREA = float(os.environ.get("DETECT_MAX_AREA", "0.55"))
DETECT_WHITE_CARS = os.environ.get("DETECT_WHITE_CARS", "1").strip() not in (
    "0",
    "false",
    "False",
    "no",
)
# Back-compat: old env name still works if WHITE not set explicitly
if "DETECT_WHITE_CARS" not in os.environ and os.environ.get("DETECT_RED_CARS", "").strip() in (
    "0",
    "false",
    "False",
    "no",
):
    DETECT_WHITE_CARS = False
MIN_YELLOW = float(os.environ.get("DETECT_MIN_YELLOW", "0.25"))
MIN_WHITE = float(os.environ.get("DETECT_MIN_WHITE", "0.35"))
UA = "stocker-detect-lite/1.0"


def log(*args):
    print(datetime.now(timezone.utc).isoformat(), *args, flush=True)


def get_hls_url(image_id: str) -> str:
    url = f"https://511ga.org/Camera/GetVideoUrl?imageId={image_id}&_={int(time.time() * 1000)}"
    req = Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urlopen(req, timeout=20) as res:
        raw = res.read().decode("utf-8", errors="replace").strip()
    if raw.startswith('"') and raw.endswith('"'):
        raw = json.loads(raw)
    return str(raw).strip().strip('"')


class StreamGrabber:
    """Keep HLS open so we can sample ~every 0.1s instead of relaunching ffmpeg."""

    def __init__(self):
        self.cap = None
        self.url = None

    def close(self):
        if self.cap is not None:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None
            self.url = None

    def open(self, hls_url: str) -> bool:
        self.close()
        cap = cv2.VideoCapture(hls_url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if not cap.isOpened():
            return False
        self.cap = cap
        self.url = hls_url
        return True

    def read(self, hls_url: str) -> np.ndarray | None:
        if self.cap is None or self.url != hls_url:
            if not self.open(hls_url):
                return self._ffmpeg_once(hls_url)
        assert self.cap is not None
        # Drop a couple buffered frames so we aren't stuck on old data
        ok, frame = False, None
        for _ in range(3):
            ok, frame = self.cap.read()
        if ok and frame is not None and frame.size:
            return frame
        # reconnect once
        if not self.open(hls_url):
            return self._ffmpeg_once(hls_url)
        ok, frame = self.cap.read()
        if ok and frame is not None and frame.size:
            return frame
        return self._ffmpeg_once(hls_url)

    @staticmethod
    def _ffmpeg_once(hls_url: str) -> np.ndarray | None:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            out = tmp.name
        try:
            proc = subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-rw_timeout",
                    "15000000",
                    "-i",
                    hls_url,
                    "-frames:v",
                    "1",
                    "-q:v",
                    "3",
                    out,
                ],
                timeout=45,
                capture_output=True,
            )
            if proc.returncode != 0 or not Path(out).exists() or Path(out).stat().st_size < 100:
                return None
            return cv2.imread(out)
        except Exception:
            return None
        finally:
            try:
                Path(out).unlink(missing_ok=True)
            except Exception:
                pass


def motion_score(prev_gray: np.ndarray | None, frame: np.ndarray) -> tuple[float, np.ndarray]:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    if prev_gray is None:
        return 0.0, gray
    a = cv2.resize(prev_gray, (320, 180))
    b = cv2.resize(gray, (320, 180))
    return float(np.mean(cv2.absdiff(a, b))), gray


def yellow_mask(frame: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    # School-bus yellow / amber
    return cv2.inRange(hsv, (12, 90, 90), (40, 255, 255))


def white_mask(frame: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    # Low saturation + high value ≈ white / light silver
    return cv2.inRange(hsv, (0, 0, 170), (179, 55, 255))


def find_color_blob(
    frame: np.ndarray,
    mask: np.ndarray,
    *,
    min_fill: float,
    aspect_min: float,
    aspect_max: float,
    target_aspect: float,
    min_area: float | None = None,
    max_area: float | None = None,
):
    """Return (score, x1,y1,x2,y2, fill_ratio, aspect, area) or None."""
    h, w = frame.shape[:2]
    area_frame = float(h * w)
    amin = MIN_AREA if min_area is None else min_area
    amax = MAX_AREA if max_area is None else max_area
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    best = None
    for cnt in contours:
        x, y, bw, bh = cv2.boundingRect(cnt)
        area = float(bw * bh) / area_frame
        if area < amin or area > amax:
            continue
        if bh < 10 or bw < 18:
            continue
        aspect = bw / float(bh)
        if aspect < aspect_min or aspect > aspect_max:
            continue
        roi = mask[y : y + bh, x : x + bw]
        if roi.size == 0:
            continue
        fill = float(np.count_nonzero(roi)) / float(roi.size)
        if fill < min_fill:
            continue
        aspect_score = 1.0 - min(abs(aspect - target_aspect) / max(target_aspect, 0.1), 1.0)
        score = fill * 0.55 + min(area / 0.12, 1.0) * 0.25 + aspect_score * 0.2
        if best is None or score > best[0]:
            best = (score, x, y, x + bw, y + bh, fill, aspect, area)
    return best


def find_school_bus(frame: np.ndarray):
    return find_color_blob(
        frame,
        yellow_mask(frame),
        min_fill=MIN_YELLOW,
        aspect_min=1.2,
        aspect_max=5.5,
        target_aspect=2.6,
    )


def find_white_car(frame: np.ndarray):
    # Cars tend to be a bit more compact than buses
    return find_color_blob(
        frame,
        white_mask(frame),
        min_fill=MIN_WHITE,
        aspect_min=1.15,
        aspect_max=3.8,
        target_aspect=1.9,
        min_area=max(0.006, MIN_AREA * 0.6),
        max_area=min(0.35, MAX_AREA),
    )


def notify_discord(frame: np.ndarray, meta: dict) -> None:
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok:
        raise RuntimeError("jpeg encode failed")
    kind = meta.get("kind", "bus")
    if kind == "white_car":
        title = "⚪ **White car detected!** (temporary)"
        color_label = "white"
        filename = "white-car.jpg"
        box_hint = "white"
    else:
        title = "🟡 **School bus detected!**"
        color_label = "yellow"
        filename = "bus.jpg"
        box_hint = "yellow"
    content = (
        f"{title}\n"
        f"Camera `{IMAGE_ID}` · score `{meta['score']:.0%}` · "
        f"{color_label} `{meta['fill']:.0%}` · size `{meta['area']:.0%}` of frame\n"
        f"<t:{int(time.time())}:F>"
    )
    r = requests.post(
        WEBHOOK,
        data={"payload_json": json.dumps({"content": content})},
        files={"files[0]": (filename, buf.tobytes(), "image/jpeg")},
        timeout=30,
    )
    if r.status_code >= 300:
        raise RuntimeError(f"Discord HTTP {r.status_code}: {r.text[:200]}")


def emit_alert(frame, hit, kind: str, last_alert_map: dict, label: str, box_color):
    s, x1, y1, x2, y2, fill, aspect, area = hit
    now = time.time()
    last = last_alert_map.get(kind, 0.0)
    if now - last < COOLDOWN:
        log(
            f"{label} candidate score={s:.2f} "
            f"(cooldown {int(COOLDOWN - (now - last))}s)"
        )
        return
    annotated = frame.copy()
    cv2.rectangle(annotated, (x1, y1), (x2, y2), box_color, 3)
    cv2.putText(
        annotated,
        f"{label} {s:.0%}",
        (x1, max(24, y1 - 8)),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        box_color,
        2,
    )
    log(
        f"ALERT {kind} score={s:.2f} fill={fill:.2f} "
        f"aspect={aspect:.1f} area={area:.3f}"
    )
    if WEBHOOK:
        notify_discord(
            annotated,
            {"kind": kind, "score": s, "fill": fill, "area": area},
        )
        log("Discord notified")
    last_alert_map[kind] = now


def main() -> int:
    log(
        f"Lite detector starting (image {IMAGE_ID}, every {INTERVAL}s, "
        f"motion≥{MOTION_THR}, cooldown {COOLDOWN}s, "
        f"white_cars={'on' if DETECT_WHITE_CARS else 'off'}, "
        f"webhook={'yes' if WEBHOOK else 'no'})"
    )
    if not WEBHOOK:
        log("WARNING: DISCORD_WEBHOOK_URL missing — will only log")

    # Startup ping so you know Discord wiring works
    if WEBHOOK:
        try:
            extra = " + temporary white-car alerts" if DETECT_WHITE_CARS else ""
            r = requests.post(
                WEBHOOK,
                json={
                    "content": (
                        f"✅ Detector online for camera `{IMAGE_ID}` "
                        f"(school bus{extra})."
                    )
                },
                timeout=20,
            )
            log(f"Discord startup ping HTTP {r.status_code}")
        except Exception as e:
            log(f"Discord startup ping failed: {e}")

    prev_gray = None
    last_alert_map: dict[str, float] = {}
    last_heartbeat = 0.0
    hls_url = None
    hls_at = 0.0
    frames_ok = 0
    failures = 0
    grabber = StreamGrabber()

    while True:
        t0 = time.time()
        try:
            if not hls_url or time.time() - hls_at > 240:
                hls_url = get_hls_url(IMAGE_ID)
                hls_at = time.time()
                grabber.close()
                log("Refreshed HLS URL")

            frame = grabber.read(hls_url)
            if frame is None:
                failures += 1
                log("Frame grab failed")
                hls_url = None
                grabber.close()
                time.sleep(min(5, 0.5 + failures * 0.2))
                continue
            failures = 0
            frames_ok += 1

            score, prev_gray = motion_score(prev_gray, frame)
            if time.time() - last_heartbeat >= 60:
                log(f"Heartbeat frames={frames_ok} motion={score:.1f}")
                last_heartbeat = time.time()

            if score < MOTION_THR:
                pass
            else:
                bus = find_school_bus(frame)
                white = find_white_car(frame) if DETECT_WHITE_CARS else None
                any_hit = False
                if bus:
                    any_hit = True
                    emit_alert(
                        frame,
                        bus,
                        "bus",
                        last_alert_map,
                        "school bus",
                        (0, 200, 255),
                    )
                if white:
                    any_hit = True
                    emit_alert(
                        frame,
                        white,
                        "white_car",
                        last_alert_map,
                        "white car",
                        (255, 255, 255),
                    )
                if not any_hit:
                    log(f"Motion {score:.1f} — no bus/white-car match")

        except KeyboardInterrupt:
            log("Shutting down")
            grabber.close()
            return 0
        except Exception as e:
            log(f"Loop error: {e}")
            hls_url = None
            grabber.close()
            time.sleep(1)

        elapsed = time.time() - t0
        time.sleep(max(0.0, INTERVAL - elapsed))


if __name__ == "__main__":
    raise SystemExit(main())
