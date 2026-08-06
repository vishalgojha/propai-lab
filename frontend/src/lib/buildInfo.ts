export function getBuildLabel() {
  const raw =
    process.env.NEXT_PUBLIC_APP_BUILD ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_COMMIT_SHA ||
    "dev";

  if (!raw || raw === "dev") return "dev";
  return raw.slice(0, 8);
}

export function getBuildHint() {
  return "If this looks old, hard refresh the page.";
}
