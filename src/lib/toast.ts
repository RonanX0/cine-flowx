import { toast } from "sonner";

export { toast };

/** Toast no máximo 1x por janela de tempo para a mesma chave (evita spam). */
const lastShown: Record<string, number> = {};

export function toastOnce(
  key: string,
  message: string,
  kind: "success" | "warning" | "error" | "info" = "info",
  windowMs = 5 * 60 * 1000
): boolean {
  const nowMs = Date.now();
  if (lastShown[key] && nowMs - lastShown[key] < windowMs) return false;
  lastShown[key] = nowMs;
  try {
    if (kind === "success") toast.success(message);
    else if (kind === "warning") toast.warning(message);
    else if (kind === "error") toast.error(message);
    else toast.info(message);
    return true;
  } catch {
    return false;
  }
}
