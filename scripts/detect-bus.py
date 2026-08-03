#!/usr/bin/env python3
"""
YOLOv8n school-bus detector → Discord.

COCO car/bus/truck detections, then a yellow color filter so only school buses
alert (city buses / white cars do not).

Env:
  IMAGE_ID, DISCORD_WEBHOOK_URL
  DETECT_INTERVAL_SECS (default 0.5)  # YOLO on 1 CPU can't do true 0.1s
  DETECT_COOLDOWN_SECS (default 60)
  DETECT_MOTION_THRESHOLD (default 5)
  DETECT_CONF (default 0.35)
  DETECT_YELLOW_MIN (default 0.08)  # ROI fraction that must be school-bus yellow
  DETECT_WHITE_CARS (default 0)     # temporary debug only
  YOLO_MODEL (default yolov8n.pt)
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen

import cv2
import numpy as np
import requests

IMAGE_ID = os.environ.get("IMAGE_ID", "19494")
WEBHOOK = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
INTERVAL = max(0.1, float(os.environ.get("DETECT_INTERVAL_SECS", "0.5")))
COOLDOWN = max(15.0, float(os.environ.get("DETECT_COOLDOWN_SECS", "60")))
MOTION_THR = float(os.environ.get("DETECT_MOTION_THRESHOLD", "5"))
CONF = float(os.environ.get("DETECT_CONF", "0.35"))
YELLOW_MIN = float(os.environ.get("DETECT_YELLOW_MIN", "0.08"))
DETECT_WHITE_CARS = os.environ.get("DETECT_WHITE_CARS", "0").strip() not in (
    "0",
    "false",
    "False",
    "no",
)
MODEL_NAME = os.environ.get("YOLO_MODEL", "yolov8n.pt")
# COCO ids — school buses are usually "bus", sometimes "truck"
CLS_CAR, CLS_BUS, CLS_TRUCK = 2, 5, 7
UA = "stocker-yolo/1.0"


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

    def read(self, hls_url: str):
        if self.cap is None or self.url != hls_url:
            if not self.open(hls_url):
                return None
        assert self.cap is not None
        ok, frame = False, None
        for _ in range(2):
            ok, frame = self.cap.read()
        if ok and frame is not None and frame.size:
            return frame
        if not self.open(hls_url):
            return None
        ok, frame = self.cap.read()
        if ok and frame is not None and frame.size:
            return frame
        return None


def motion_score(prev_gray, frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    if prev_gray is None:
        return 0.0, gray
    a = cv2.resize(prev_gray, (320, 180))
    b = cv2.resize(gray, (320, 180))
    return float(np.mean(cv2.absdiff(a, b))), gray


def color_ratio(frame, xyxy, kind: str) -> float:
    x1, y1, x2, y2 = [int(v) for v in xyxy]
    h, w = frame.shape[:2]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)
    if x2 <= x1 or y2 <= y1:
        return 0.0
    roi = frame[y1:y2, x1:x2]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    if kind == "yellow":
        # School-bus chrome yellow / amber
        mask = cv2.inRange(hsv, (8, 60, 70), (42, 255, 255))
    else:  # white
        mask = cv2.inRange(hsv, (0, 0, 170), (179, 60, 255))
    return float(np.count_nonzero(mask)) / float(mask.size)


def notify_discord(frame, title: str, filename: str, meta: str):
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok:
        raise RuntimeError("jpeg encode failed")
    content = f"{title}\nCamera `{IMAGE_ID}` · {meta}\n<t:{int(time.time())}:F>"
    r = requests.post(
        WEBHOOK,
        data={"payload_json": json.dumps({"content": content})},
        files={"files[0]": (filename, buf.tobytes(), "image/jpeg")},
        timeout=30,
    )
    if r.status_code >= 300:
        raise RuntimeError(f"Discord HTTP {r.status_code}: {r.text[:200]}")


def main() -> int:
    from ultralytics import YOLO

    log(
        f"School-bus detector starting (model={MODEL_NAME}, image={IMAGE_ID}, "
        f"every {INTERVAL}s, motion≥{MOTION_THR}, conf≥{CONF}, "
        f"yellow≥{YELLOW_MIN}, white_cars={'on' if DETECT_WHITE_CARS else 'off'}, "
        f"webhook={'yes' if WEBHOOK else 'no'})"
    )
    model = YOLO(MODEL_NAME)
    log("Model loaded")

    if WEBHOOK:
        try:
            r = requests.post(
                WEBHOOK,
                json={
                    "content": (
                        f"✅ School bus detector online (`{MODEL_NAME}`) for camera "
                        f"`{IMAGE_ID}` — yellow school buses only."
                    )
                },
                timeout=20,
            )
            log(f"Discord startup ping HTTP {r.status_code}")
        except Exception as e:
            log(f"Discord startup ping failed: {e}")

    grabber = StreamGrabber()
    prev_gray = None
    last_alert = {"bus": 0.0, "white_car": 0.0}
    last_heartbeat = 0.0
    hls_url = None
    hls_at = 0.0
    frames_ok = 0
    failures = 0
    classes = [CLS_CAR, CLS_BUS, CLS_TRUCK]

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
                time.sleep(max(0.0, INTERVAL - (time.time() - t0)))
                continue

            results = model.predict(
                frame,
                classes=classes,
                conf=CONF,
                verbose=False,
                imgsz=640,
            )
            boxes = results[0].boxes
            best_bus = None
            best_white = None

            for box in boxes:
                cls_id = int(box.cls[0])
                conf = float(box.conf[0])
                xyxy = box.xyxy[0].tolist()
                name = {CLS_CAR: "car", CLS_BUS: "bus", CLS_TRUCK: "truck"}.get(
                    cls_id, str(cls_id)
                )

                # School bus: yellow body on bus/truck (YOLO sometimes says truck)
                if cls_id in (CLS_BUS, CLS_TRUCK):
                    y = color_ratio(frame, xyxy, "yellow")
                    if y >= YELLOW_MIN:
                        key = conf + y
                        if best_bus is None or key > best_bus[0]:
                            best_bus = (key, conf, y, xyxy, name)

                if DETECT_WHITE_CARS and cls_id in (CLS_CAR, CLS_TRUCK):
                    w = color_ratio(frame, xyxy, "white")
                    if w >= 0.25:
                        key = conf + w
                        if best_white is None or key > best_white[0]:
                            best_white = (key, conf, w, xyxy, name)

            now = time.time()
            if best_bus:
                _, conf, y, xyxy, name = best_bus
                if now - last_alert["bus"] >= COOLDOWN:
                    annotated = frame.copy()
                    x1, y1, x2, y2 = [int(v) for v in xyxy]
                    cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 200, 255), 3)
                    cv2.putText(
                        annotated,
                        f"school bus {conf:.0%} y={y:.0%}",
                        (x1, max(24, y1 - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.7,
                        (0, 200, 255),
                        2,
                    )
                    log(f"ALERT school bus conf={conf:.2f} yellow={y:.2f} cls={name}")
                    if WEBHOOK:
                        notify_discord(
                            annotated,
                            "🟡 **School bus detected!**",
                            "bus.jpg",
                            f"YOLO `{name}` · conf `{conf:.0%}` · yellow `{y:.0%}`",
                        )
                    last_alert["bus"] = now
                else:
                    log("School-bus hit during cooldown")

            if best_white:
                _, conf, w, xyxy, name = best_white
                if now - last_alert["white_car"] >= COOLDOWN:
                    annotated = frame.copy()
                    x1, y1, x2, y2 = [int(v) for v in xyxy]
                    cv2.rectangle(annotated, (x1, y1), (x2, y2), (255, 255, 255), 3)
                    cv2.putText(
                        annotated,
                        f"white {name} {conf:.0%} w={w:.0%}",
                        (x1, max(24, y1 - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.7,
                        (255, 255, 255),
                        2,
                    )
                    log(f"ALERT white {name} conf={conf:.2f} white={w:.2f}")
                    if WEBHOOK:
                        notify_discord(
                            annotated,
                            "⚪ **White car detected!** (debug)",
                            "white-car.jpg",
                            f"YOLO `{name}` · conf `{conf:.0%}` · white `{w:.0%}`",
                        )
                    last_alert["white_car"] = now
                else:
                    log("White-car hit during cooldown")

            if boxes is None or len(boxes) == 0:
                log(f"Motion {score:.1f} — YOLO found no car/bus/truck")

        except KeyboardInterrupt:
            grabber.close()
            return 0
        except Exception as e:
            log(f"Loop error: {e}")
            hls_url = None
            grabber.close()
            time.sleep(1)

        time.sleep(max(0.0, INTERVAL - (time.time() - t0)))


if __name__ == "__main__":
    raise SystemExit(main())
