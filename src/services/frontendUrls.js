const DEFAULT_FRONTEND_URL = "http://localhost:5173";

function configuredFrontendUrls() {
  return (process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) return null;
        return url;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function getAllowedFrontendOrigins() {
  return [...new Set(configuredFrontendUrls().map((url) => url.origin))];
}

function getDefaultFrontendReturnTo(pathname = "/dashboard") {
  const base = configuredFrontendUrls()[0] || new URL(DEFAULT_FRONTEND_URL);
  return new URL(pathname, `${base.origin}/`).toString();
}

function getSafeFrontendReturnTo(candidate, fallbackPath = "/dashboard") {
  if (candidate === undefined || candidate === null || candidate === "") {
    return getDefaultFrontendReturnTo(fallbackPath);
  }
  if (typeof candidate !== "string" || candidate.length > 2048) return null;

  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (!getAllowedFrontendOrigins().includes(url.origin)) return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function withQueryParams(destination, values) {
  const url = new URL(destination);
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function withFragmentParams(destination, values) {
  const url = new URL(destination);
  const fragment = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null) fragment.set(key, String(value));
  });
  url.hash = fragment.toString();
  return url.toString();
}

module.exports = {
  getAllowedFrontendOrigins,
  getDefaultFrontendReturnTo,
  getSafeFrontendReturnTo,
  withFragmentParams,
  withQueryParams,
};
