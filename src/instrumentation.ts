export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureWorkerStarted } = await import("@/lib/worker");
    // kick off async — replay yields so startup healthchecks are not blocked
    setTimeout(() => ensureWorkerStarted(), 50);
  }
}
