const { sendJson, setCors } = require("./_http");

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-4.1-mini";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const ALLOWED_STATUSES = new Set(["PASS", "FAIL", "RETRY"]);

function getJsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === "string") {
    return JSON.parse(req.body);
  }

  throw new Error("Missing JSON body");
}

function validateInput(body) {
  const fileUrl = typeof body.file_url === "string" ? body.file_url.trim() : "";
  const imageData =
    typeof body.image_data === "string" ? body.image_data.trim() : "";
  const expectedHandle =
    typeof body.expected_handle === "string" ? body.expected_handle.trim() : "";

  if ((!fileUrl && !imageData) || !expectedHandle) return null;

  if (imageData) {
    return { imageData, expectedHandle };
  }

  const parsedUrl = new URL(fileUrl);
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return null;
  }

  return { fileUrl: parsedUrl.toString(), expectedHandle };
}

function validateImageDataUrl(imageData) {
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+\/]+={0,2})$/i.exec(
    imageData,
  );
  if (!match) throw new Error("Invalid image data URL");

  const contentType = match[1].toLowerCase();
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("Image is empty or too large");
  }

  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

async function fetchImageAsDataUrl(fileUrl) {
  const response = await fetch(fileUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Accept: "image/png,image/jpeg,image/webp,image/gif",
      "User-Agent": "qualtrics-verifier/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Image fetch failed with HTTP ${response.status}`);
  }

  const contentType = (response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new Error("Unsupported image content type");
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    throw new Error("Image is too large");
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("Image is empty or too large");
  }

  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

async function verifyScreenshot(imageDataUrl, expectedHandle, apiKey) {
  const response = await fetch(OPENAI_URL, {
    method: "POST",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      store: false,
      instructions: [
        "You verify screenshots of X/Twitter profile pages.",
        "Return PASS only when the screenshot clearly shows the expected account and a visible Following state.",
        "Return FAIL when it clearly shows a different account, clearly shows Follow instead of Following, or is clearly irrelevant.",
        "Return RETRY when the screenshot is blurry, cropped, unreadable, ambiguous, or lacks enough visual evidence.",
        "Technical uncertainty in reading the image must be RETRY, never FAIL.",
      ].join(" "),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Expected X/Twitter handle: ${expectedHandle}`,
            },
            {
              type: "input_image",
              image_url: imageDataUrl,
              detail: "high",
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "follow_verification",
          strict: true,
          schema: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["PASS", "FAIL", "RETRY"] },
            },
            required: ["status"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  const outputText = Array.isArray(payload.output)
    ? payload.output
        .filter((item) => item && item.type === "message")
        .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
        .find((item) => item && item.type === "output_text")?.text
    : null;

  if (payload.status !== "completed" || typeof outputText !== "string") {
    throw new Error("OpenAI response was incomplete");
  }

  const result = JSON.parse(outputText);
  if (!result || !ALLOWED_STATUSES.has(result.status)) {
    throw new Error("OpenAI returned an invalid verification status");
  }

  return result.status;
}

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return sendJson(res, 405, { status: "RETRY" });
  }

  let input;
  try {
    input = validateInput(getJsonBody(req));
  } catch {
    input = null;
  }

  if (!input) {
    return sendJson(res, 400, { status: "RETRY" });
  }

  try {
    const apiKey = process.env.OPENAI_API;
    if (!apiKey) throw new Error("OPENAI_API is not configured");

    // Qualtrics temporary URLs can require the survey browser session cookie.
    // Prefer bytes read by that browser; keep file_url for ordinary public URLs.
    const imageDataUrl = input.imageData
      ? validateImageDataUrl(input.imageData)
      : await fetchImageAsDataUrl(input.fileUrl);
    const status = await verifyScreenshot(
      imageDataUrl,
      input.expectedHandle,
      apiKey,
    );
    return sendJson(res, 200, { status });
  } catch (error) {
    console.error("verify-follow failed", error);
    return sendJson(res, 500, {
      status: "ERROR",
      reason: "Verification service failed",
    });
  }
}

module.exports = handler;
module.exports._test = {
  fetchImageAsDataUrl,
  validateImageDataUrl,
  validateInput,
  verifyScreenshot,
};
