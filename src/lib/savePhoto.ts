/**
 * Saves a photo to the device. Phones get the share sheet (which has
 * "Save Image"); computers get a normal download. Throws on failure, except
 * when the person closes the share sheet (resolves `false`).
 */
export async function savePhoto(src: string, namePrefix = "kano-market"): Promise<boolean> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const ext = blob.type.split("/")[1]?.split(";")[0] || "jpg";
  const file = new File([blob], `${namePrefix}-${Date.now()}.${ext}`, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return false;
      throw error;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
