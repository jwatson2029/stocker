#!/usr/bin/env python3
"""
YOLOv8 school-bus + people detector → Discord.

Full-frame YOLO (no ROI crop). School bus = yellow body on bus/truck/car
candidates with class-dependent yellow + shape gates (cars need much stronger
yellow so ordinary vehicles don't alert).

Env:
  IMAGE_ID, DISCORD_WEBHOOK_URL
  DETECT_INTERVAL_SECS (default 0.15)
  DETECT_COOLDOWN_SECS (default 60)
  DETECT_MOTION_THRESHOLD (default 3)
  DETECT_FORCE_YOLO_SECS (default 0.8)  # run YOLO even if motion is low
  DETECT_CONF (default 0.22)
  DETECT_IMGSZ (default 800)  # higher = better small/far; lower = faster checks
  DETECT_YELLOW_MIN (default 0.12)  # base yellow fraction (bus class)
  DETECT_PEOPLE (default 1)
  DETECT_PERSON_MIN_AREA (default 0.001)
  DETECT_WHITE_CARS (default 0)
  YOLO_MODEL (default yolo26s.pt)
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
INTERVAL = max(0.05, float(os.environ.get("DETECT_INTERVAL_SECS", "0.15")))
COOLDOWN = max(15.0, float(os.environ.get("DETECT_COOLDOWN_SECS", "60")))
MOTION_THR = float(os.environ.get("DETECT_MOTION_THRESHOLD", "3"))
FORCE_YOLO_SECS = max(0.25, float(os.environ.get("DETECT_FORCE_YOLO_SECS", "0.8")))
CONF = float(os.environ.get("DETECT_CONF", "0.22"))
IMGSZ = int(os.environ.get("DETECT_IMGSZ", "800"))
YELLOW_MIN = float(os.environ.get("DETECT_YELLOW_MIN", "0.12"))
PERSON_MIN_AREA = float(os.environ.get("DETECT_PERSON_MIN_AREA", "0.001"))
DETECT_PEOPLE = os.environ.get("DETECT_PEOPLE", "1").strip() not in (
    "0",
    "false",
    "False",
    "no",
)
DETECT_WHITE_CARS = os.environ.get("DETECT_WHITE_CARS", "0").strip() not in (
    "0",
    "false",
    "False",
    "no",
)
MODEL_NAME = os.environ.get("YOLO_MODEL", "yolo26s.pt")
# COCO ids — distant school buses are often "car"; close ones "bus"/"truck"
CLS_PERSON, CLS_CAR, CLS_BUS, CLS_TRUCK = 0, 2, 5, 7
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
        # Drain one stale buffered frame, then take the newest (keeps latency low).
        self.cap.grab()
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


def _clamp_box(xyxy, w: int, h: int):
    x1, y1, x2, y2 = [int(v) for v in xyxy]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)
    if x2 <= x1 or y2 <= y1:
        return None
    return x1, y1, x2, y2


def color_ratio(frame, xyxy, kind: str, *, inset: float = 0.0) -> float:
    """Fraction of ROI pixels matching color. inset>0 uses inner crop (skip road/sky)."""
    h, w = frame.shape[:2]
    box = _clamp_box(xyxy, w, h)
    if box is None:
        return 0.0
    x1, y1, x2, y2 = box
    if inset > 0:
        bw, bh = x2 - x1, y2 - y1
        dx, dy = int(bw * inset), int(bh * inset)
        x1, y1 = x1 + dx, y1 + dy
        x2, y2 = x2 - dx, y2 - dy
        if x2 <= x1 or y2 <= y1:
            return 0.0
    roi = frame[y1:y2, x1:x2]
    if roi.size == 0:
        return 0.0
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    if kind == "yellow":
        # School-bus chrome yellow (tighter than amber/headlights)
        mask = cv2.inRange(hsv, (12, 90, 90), (38, 255, 255))
    else:  # white
        mask = cv2.inRange(hsv, (0, 0, 170), (179, 60, 255))
    return float(np.count_nonzero(mask)) / float(mask.size)


def box_geom(xyxy, frame_area: float):
    x1, y1, x2, y2 = xyxy
    bw = max(1.0, float(x2 - x1))
    bh = max(1.0, float(y2 - y1))
    area = (bw * bh) / frame_area
    aspect = bw / bh
    return area, aspect


def school_bus_yellow(frame, xyxy) -> float:
    """Yellow score from body of vehicle (inner bbox), not wheels/road."""
    return color_ratio(frame, xyxy, "yellow", inset=0.18)


def is_school_bus_candidate(cls_id: int, conf: float, yellow: float, area: float, aspect: float):
    """
    Class-dependent gates:
      bus   — YOLO said bus; moderate yellow enough
      truck — often cars mislabeled; need more yellow + bus-like proportions
      car   — distant buses often labeled car; strict yellow + wide/large body
    Rejects ordinary cars/trucks that only have a bit of amber light/paint.
    """
    # Tiny specs / noise
    if area < 0.0004:
        return False

    if cls_id == CLS_BUS:
        # Real bus class: allow smaller/far objects; still need real yellow body
        if yellow < YELLOW_MIN:
            return False
        if conf < CONF:
            return False
        # Front-on buses can be near-square; side views are wide
        if aspect < 0.55 or aspect > 5.0:
            return False
        return True

    if cls_id == CLS_TRUCK:
        # Trucks/SUVs often FP as "yellow school bus" — be stricter
        if yellow < max(0.20, YELLOW_MIN * 1.6):
            return False
        if conf < max(CONF, 0.28):
            return False
        # Prefer elongated side profiles typical of a bus
        if aspect < 1.15 or aspect > 4.5:
            return False
        if area < 0.001:
            return False
        return True

    if cls_id == CLS_CAR:
        # Only for far buses YOLO calls "car" — require lots of chrome yellow
        if yellow < max(0.28, YELLOW_MIN * 2.2):
            return False
        if conf < max(CONF, 0.25):
            return False
        if aspect < 1.25 or aspect > 4.5:
            return False
        if area < 0.0008:
            return False
        return True

    return False


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

    targets = ["school buses"]
    if DETECT_PEOPLE:
        targets.append("people")
    log(
        f"Detector starting (model={MODEL_NAME}, image={IMAGE_ID}, "
        f"every {INTERVAL}s, motion≥{MOTION_THR}, force_yolo≤{FORCE_YOLO_SECS}s, "
        f"conf≥{CONF}, imgsz={IMGSZ}, yellow≥{YELLOW_MIN}, "
        f"people={'on' if DETECT_PEOPLE else 'off'}, "
        f"white_cars={'on' if DETECT_WHITE_CARS else 'off'}, "
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
                        f"✅ Detector online (`{MODEL_NAME}`) for camera "
                        f"`{IMAGE_ID}` — {', '.join(targets)} "
                        f"(full frame, imgsz={IMGSZ})."
                    )
                },
                timeout=20,
            )
            log(f"Discord startup ping HTTP {r.status_code}")
        except Exception as e:
            log(f"Discord startup ping failed: {e}")

    grabber = StreamGrabber()
    prev_gray = None
    last_alert = {"bus": 0.0, "person": 0.0, "white_car": 0.0}
    last_heartbeat = 0.0
    last_yolo_at = 0.0
    hls_url = None
    hls_at = 0.0
    frames_ok = 0
    failures = 0
    classes = [CLS_CAR, CLS_BUS, CLS_TRUCK]
    if DETECT_PEOPLE:
        classes = [CLS_PERSON, *classes]

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

            # Always scan the full frame: motion can be quiet when a bus is
            # already in view (esp. far / top-left), so force YOLO periodically.
            force = (time.time() - last_yolo_at) >= FORCE_YOLO_SECS
            if score < MOTION_THR and not force:
                time.sleep(max(0.0, INTERVAL - (time.time() - t0)))
                continue

            last_yolo_at = time.time()
            results = model.predict(
                frame,
                classes=classes,
                conf=CONF,
                verbose=False,
                imgsz=IMGSZ,
                # Slight boost for edge / small objects without a second model
                augment=False,
                agnostic_nms=False,
            )
            boxes = results[0].boxes
            best_bus = None
            best_person = None
            best_white = None
            fh, fw = frame.shape[:2]
            frame_area = float(fh * fw)

            for box in boxes:
                cls_id = int(box.cls[0])
                conf = float(box.conf[0])
                xyxy = box.xyxy[0].tolist()
                name = {
                    CLS_PERSON: "person",
                    CLS_CAR: "car",
                    CLS_BUS: "bus",
                    CLS_TRUCK: "truck",
                }.get(cls_id, str(cls_id))

                if cls_id in (CLS_BUS, CLS_TRUCK, CLS_CAR):
                    area, aspect = box_geom(xyxy, frame_area)
                    yellow = school_bus_yellow(frame, xyxy)
                    if is_school_bus_candidate(cls_id, conf, yellow, area, aspect):
                        # Prefer true "bus" class, then yellow strength, then conf
                        class_boost = {CLS_BUS: 1.0, CLS_TRUCK: 0.35, CLS_CAR: 0.15}.get(
                            cls_id, 0.0
                        )
                        key = class_boost + yellow + conf * 0.5
                        if best_bus is None or key > best_bus[0]:
                            best_bus = (key, conf, yellow, xyxy, name, area, aspect)

                if DETECT_PEOPLE and cls_id == CLS_PERSON:
                    x1, y1, x2, y2 = xyxy
                    area = max(0.0, (x2 - x1) * (y2 - y1)) / frame_area
                    if area >= PERSON_MIN_AREA:
                        key = conf + area
                        if best_person is None or key > best_person[0]:
                            best_person = (key, conf, area, xyxy)

                if DETECT_WHITE_CARS and cls_id in (CLS_CAR, CLS_TRUCK):
                    w = color_ratio(frame, xyxy, "white")
                    if w >= 0.25:
                        key = conf + w
                        if best_white is None or key > best_white[0]:
                            best_white = (key, conf, w, xyxy, name)

            now = time.time()
            if best_bus:
                _, conf, y, xyxy, name, area, aspect = best_bus
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
                    log(
                        f"ALERT school bus conf={conf:.2f} yellow={y:.2f} "
                        f"cls={name} area={area:.4f} aspect={aspect:.2f}"
                    )
                    if WEBHOOK:
                        notify_discord(
                            annotated,
                            "🟡 **School bus detected!**",
                            "bus.jpg",
                            (
                                f"YOLO `{name}` · conf `{conf:.0%}` · "
                                f"yellow `{y:.0%}` · area `{area:.2%}`"
                            ),
                        )
                    last_alert["bus"] = now
                else:
                    log("School-bus hit during cooldown")

            if best_person:
                _, conf, area, xyxy = best_person
                if now - last_alert["person"] >= COOLDOWN:
                    annotated = frame.copy()
                    x1, y1, x2, y2 = [int(v) for v in xyxy]
                    cv2.rectangle(annotated, (x1, y1), (x2, y2), (80, 180, 255), 3)
                    cv2.putText(
                        annotated,
                        f"person {conf:.0%}",
                        (x1, max(24, y1 - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.7,
                        (80, 180, 255),
                        2,
                    )
                    log(f"ALERT person conf={conf:.2f} area={area:.4f}")
                    if WEBHOOK:
                        notify_discord(
                            annotated,
                            "🚶 **Person detected!**",
                            "person.jpg",
                            f"YOLO `person` · conf `{conf:.0%}` · area `{area:.2%}`",
                        )
                    last_alert["person"] = now
                else:
                    log("Person hit during cooldown")

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
                log(f"Motion {score:.1f} — YOLO found nothing")

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
