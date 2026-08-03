#!/usr/bin/env python3
"""
School-bus detector for 511GA HLS camera streams.

Samples frames, gates on motion, runs YOLOv8n for COCO class "bus",
checks that the box looks yellow, then posts to Discord.

Env:
  IMAGE_ID (default 19494)
  DISCORD_WEBHOOK_URL (required for alerts)
  DETECT_INTERVAL_SECS (default 3)
  DETECT_COOLDOWN_SECS (default 180)
  DETECT_MOTION_THRESHOLD (default 12)
  DETECT_BUS_CONF (default 0.35)
  DETECT_YELLOW_RATIO (default 0.08)
  YOLO_MODEL (default yolov8n.pt)
"""

from __future__ import annotations

import os
import sys
import time
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

import cv2
import numpy as np
import requests

IMAGE_ID = os.environ.get("IMAGE_ID", "19494")
WEBHOOK = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
INTERVAL = max(1.0, float(os.environ.get("DETECT_INTERVAL_SECS", "3")))
COOLDOWN = max(30.0, float(os.environ.get("DETECT_COOLDOWN_SECS", "180")))
MOTION_THR = float(os.environ.get("DETECT_MOTION_THRESHOLD", "12"))
BUS_CONF = float(os.environ.get("DETECT_BUS_CONF", "0.35"))
YELLOW_RATIO = float(os.environ.get("DETECT_YELLOW_RATIO", "0.08"))
MODEL_NAME = os.environ.get("YOLO_MODEL", "yolov8n.pt")
# COCO class id for bus
BUS_CLASS = 5

UA = "stocker-detect/1.0"


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


def grab_frame(hls_url: str) -> np.ndarray | None:
    """Grab one JPEG frame via OpenCV HLS; fallback to ffmpeg if needed."""
    cap = cv2.VideoCapture(hls_url, cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    ok, frame = cap.read()
    if not ok:
        # flush a couple packets
        for _ in range(5):
            ok, frame = cap.read()
            if ok:
                break
    cap.release()
    if ok and frame is not None and frame.size:
        return frame

    # ffmpeg fallback
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        out = tmp.name
    cmd = (
        f'ffmpeg -hide_banner -loglevel error -y -rw_timeout 15000000 '
        f'-i "{hls_url}" -frames:v 1 -q:v 3 "{out}"'
    )
    rc = os.system(cmd)
    if rc != 0 or not Path(out).exists() or Path(out).stat().st_size < 100:
        try:
            Path(out).unlink(missing_ok=True)
        except Exception:
            pass
        return None
    frame = cv2.imread(out)
    try:
        Path(out).unlink(missing_ok=True)
    except Exception:
        pass
    return frame


def motion_score(prev_gray: np.ndarray | None, frame: np.ndarray) -> tuple[float, np.ndarray]:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    if prev_gray is None:
        return 0.0, gray
    # resize both for stable cheap compare
    a = cv2.resize(prev_gray, (320, 180))
    b = cv2.resize(gray, (320, 180))
    diff = cv2.absdiff(a, b)
    score = float(np.mean(diff))
    return score, gray


def yellow_ratio(frame: np.ndarray, xyxy) -> float:
    x1, y1, x2, y2 = [int(v) for v in xyxy]
    h, w = frame.shape[:2]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)
    if x2 <= x1 or y2 <= y1:
        return 0.0
    roi = frame[y1:y2, x1:x2]
    if roi.size == 0:
        return 0.0
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    # school-bus yellow / amber ranges
    mask1 = cv2.inRange(hsv, (15, 80, 80), (40, 255, 255))
    ratio = float(np.count_nonzero(mask1)) / float(mask1.size)
    return ratio


def notify_discord(frame: np.ndarray, conf: float, yratio: float, webhook: str) -> None:
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok:
        raise RuntimeError("jpeg encode failed")
    content = (
        f"🟡 **School bus detected!**\n"
        f"Camera `{IMAGE_ID}` · confidence `{conf:.0%}` · yellow `{yratio:.0%}`\n"
        f"<t:{int(time.time())}:F>"
    )
    # Discord requires payload_json when attaching files
    r = requests.post(
        webhook,
        data={"payload_json": json.dumps({"content": content})},
        files={"files[0]": ("bus.jpg", buf.tobytes(), "image/jpeg")},
        timeout=30,
    )
    if r.status_code >= 300:
        raise RuntimeError(f"Discord webhook HTTP {r.status_code}: {r.text[:200]}")


def main() -> int:
    log(
        f"Detector starting (image {IMAGE_ID}, every {INTERVAL}s, "
        f"motion≥{MOTION_THR}, bus≥{BUS_CONF}, yellow≥{YELLOW_RATIO}, "
        f"cooldown {COOLDOWN}s, webhook={'yes' if WEBHOOK else 'no'})"
    )
    if not WEBHOOK:
        log("WARNING: DISCORD_WEBHOOK_URL not set — detections will only be logged")

    from ultralytics import YOLO

    model = YOLO(MODEL_NAME)
    log(f"Loaded model {MODEL_NAME}")

    prev_gray = None
    last_alert = 0.0
    last_heartbeat = 0.0
    hls_url = None
    hls_fetched_at = 0.0
    failures = 0
    frames_ok = 0

    while True:
        loop_start = time.time()
        try:
            # refresh signed URL every 4 minutes
            if not hls_url or time.time() - hls_fetched_at > 240:
                hls_url = get_hls_url(IMAGE_ID)
                hls_fetched_at = time.time()
                log("Refreshed HLS URL")

            frame = grab_frame(hls_url)
            if frame is None:
                failures += 1
                log("Frame grab failed — refreshing URL")
                hls_url = None
                time.sleep(min(30, 2 + failures))
                continue
            failures = 0
            frames_ok += 1

            score, prev_gray = motion_score(prev_gray, frame)
            if time.time() - last_heartbeat >= 60:
                log(f"Heartbeat frames={frames_ok} motion={score:.1f}")
                last_heartbeat = time.time()

            if score < MOTION_THR:
                # quiet road
                pass
            else:
                results = model.predict(
                    frame,
                    classes=[BUS_CLASS],
                    conf=BUS_CONF,
                    verbose=False,
                    imgsz=640,
                )
                boxes = results[0].boxes
                best = None
                for box in boxes:
                    conf = float(box.conf[0])
                    xyxy = box.xyxy[0].tolist()
                    yr = yellow_ratio(frame, xyxy)
                    if yr < YELLOW_RATIO:
                        continue
                    if best is None or conf > best[0]:
                        best = (conf, yr, xyxy)

                if best:
                    conf, yr, xyxy = best
                    now = time.time()
                    if now - last_alert < COOLDOWN:
                        log(
                            f"Bus candidate conf={conf:.2f} yellow={yr:.2f} "
                            f"(cooldown {int(COOLDOWN - (now - last_alert))}s left)"
                        )
                    else:
                        # draw box for Discord image
                        annotated = frame.copy()
                        x1, y1, x2, y2 = [int(v) for v in xyxy]
                        cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 200, 255), 3)
                        label = f"school bus {conf:.0%} y={yr:.0%}"
                        cv2.putText(
                            annotated,
                            label,
                            (x1, max(24, y1 - 8)),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            0.7,
                            (0, 200, 255),
                            2,
                        )
                        log(f"ALERT school bus conf={conf:.2f} yellow={yr:.2f} motion={score:.1f}")
                        if WEBHOOK:
                            notify_discord(annotated, conf, yr, WEBHOOK)
                            log("Discord notified")
                        last_alert = now
                else:
                    log(f"Motion {score:.1f} but no yellow bus")

        except KeyboardInterrupt:
            log("Shutting down")
            return 0
        except Exception as e:
            log(f"Loop error: {e}")
            hls_url = None
            time.sleep(5)

        elapsed = time.time() - loop_start
        time.sleep(max(0.2, INTERVAL - elapsed))


if __name__ == "__main__":
    sys.exit(main())
