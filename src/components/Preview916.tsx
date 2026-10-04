import { useEffect, useMemo, useRef, useState } from "react";
import { computeGeometry, detectBlackBars, drawHook, type Crop } from "../lib/video";
import { cn } from "./ui";

interface Props {
  src: string;
  hookText: string;
  className?: string;
  manualCrop?: Crop | null;
  timeRange?: [number, number];
  alreadyProcessed?: boolean;
  caption?: string;
}

/** Pré-visualização 9:16 em tempo real (corte + gancho), igual ao resultado do ffmpeg. */
export function Preview916({ src, hookText, className, manualCrop, timeRange, alreadyProcessed = false, caption }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState({ vw: 1920, vh: 1080 });
  const [detected, setDetected] = useState<Crop | null>(null);

  useEffect(() => {
    setDetected(null);
    if (!src || alreadyProcessed || manualCrop !== undefined) return;
    let live = true;
    fetch(src)
      .then((r) => r.blob())
      .then((b) => detectBlackBars(b))
      .then((c) => {
        if (live && c) setDetected({ top: c.top, bottom: c.bottom, vw: c.vw, vh: c.vh });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [src, manualCrop, alreadyProcessed]);

  const crop = manualCrop !== undefined ? manualCrop : detected;
  const vw = crop?.vw || dims.vw || 1920;
  const vh = crop?.vh || dims.vh || 1080;
  const geom = useMemo(() => computeGeometry(vw, vh, crop, 720), [vw, vh, crop]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || alreadyProcessed) return;
    const text = hookText.trim();
    drawHook(canvas, geom.outWidth, geom.outHeight, geom.padY, text, !text);
  }, [hookText, geom, alreadyProcessed]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !timeRange || alreadyProcessed) return;
    const [a, b] = timeRange;
    if (v.currentTime < a || v.currentTime > b) v.currentTime = a;
    const onTime = () => {
      if (v.currentTime >= b) {
        v.currentTime = a;
        v.play().catch(() => {});
      }
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [timeRange, alreadyProcessed, src]);

  if (alreadyProcessed && src) {
    return (
      <figure className={cn("flex flex-col items-center", className)}>
        <div className="relative aspect-[9/16] w-full overflow-hidden rounded-xl border border-border bg-white shadow-sm">
          <video
            ref={videoRef}
            src={src}
            autoPlay
            muted
            loop
            playsInline
            disablePictureInPicture
            className="h-full w-full object-contain"
          />
        </div>
        <figcaption className="mt-1 text-[10px] text-muted-foreground">{caption || "Resultado 9:16"}</figcaption>
      </figure>
    );
  }

  const areaTop = (geom.padY / geom.outHeight) * 100;
  const areaLeft = (geom.padX / geom.outWidth) * 100;
  const areaW = (geom.videoW / geom.outWidth) * 100;
  const areaH = (geom.videoH / geom.outHeight) * 100;
  const videoW = (geom.vw / geom.cropW) * 100;
  const videoLeft = -((geom.cropX / geom.cropW) * 100);
  const videoTop = -((geom.cropY / geom.cropH) * 100);

  return (
    <figure className={cn("flex flex-col items-center", className)}>
      <div className="relative aspect-[9/16] w-full overflow-hidden rounded-xl border border-border bg-white shadow-sm">
        <div
          className="absolute overflow-hidden"
          style={{ top: `${areaTop}%`, left: `${areaLeft}%`, width: `${areaW}%`, height: `${areaH}%` }}
        >
          <video
            ref={videoRef}
            src={src}
            muted
            loop
            autoPlay
            playsInline
            preload="metadata"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth) setDims({ vw: v.videoWidth, vh: v.videoHeight });
            }}
            className="absolute max-w-none"
            style={{ width: `${videoW}%`, left: `${videoLeft}%`, top: `${videoTop}%` }}
          />
        </div>
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      </div>
      <figcaption className="mt-1 text-[10px] text-muted-foreground">Pré-visualização 9:16</figcaption>
    </figure>
  );
}
