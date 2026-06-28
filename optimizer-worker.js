import { optimizeGrading } from "./optimizer-core.js";

let cancelled = false;

self.addEventListener("message", async (event) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelled = true;
    return;
  }
  if (message.type !== "run") return;

  cancelled = false;
  try {
    const result = await optimizeGrading(
      message.payload,
      (progress) => self.postMessage({ type: "progress", progress }),
      () => cancelled
    );
    self.postMessage({ type: "complete", result });
  } catch (error) {
    self.postMessage({
      type: cancelled ? "cancelled" : "error",
      message: error.message || String(error)
    });
  }
});
