const assert = require("node:assert/strict");
const test = require("node:test");

const health = require("../api/health");
const verifyFollow = require("../api/verify-follow");

function createResponse() {
  return {
    headers: {},
    statusCode: 200,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body = "") {
      this.body = body;
    },
  };
}

test("GET /api/health returns the health payload and CORS", () => {
  const res = createResponse();
  health({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(res.headers["access-control-allow-origin"], "*");
});

test("verify-follow handles CORS preflight without verification", async () => {
  const res = createResponse();
  await verifyFollow({ method: "OPTIONS" }, res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-methods"], "GET,POST,OPTIONS");
});

test("verify-follow rejects missing fields", async () => {
  const res = createResponse();
  await verifyFollow({ method: "POST", body: { file_url: "https://example.com/a.png" } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), {
    status: "RETRY",
    reason: "Provide an image and expected handle.",
  });
});

test("verify-follow fetches the image and returns structured OpenAI status", async (t) => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API;
    else process.env.OPENAI_API = originalKey;
  });

  process.env.OPENAI_API = "test-key";
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return new Response(Buffer.from("fake-png"), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    return Response.json({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{
            type: "output_text",
            text: '{"status":"PASS","reason":"Expected account is visibly followed."}',
          }],
        },
      ],
    });
  };

  const res = createResponse();
  await verifyFollow({
    method: "POST",
    body: {
      file_url: "https://example.com/screenshot.png",
      expected_handle: "@expected",
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    status: "PASS",
    reason: "Expected account is visibly followed.",
  });
  assert.equal(calls[0].url, "https://example.com/screenshot.png");
  assert.equal(calls[1].url, "https://api.openai.com/v1/responses");
  const openAIRequest = JSON.parse(calls[1].options.body);
  assert.match(openAIRequest.input[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.equal(openAIRequest.text.format.strict, true);
  assert.deepEqual(openAIRequest.text.format.schema.required, ["status", "reason"]);
});

test("technical image-fetch errors return the required 500 payload", async (t) => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API;
    else process.env.OPENAI_API = originalKey;
  });

  process.env.OPENAI_API = "test-key";
  global.fetch = async () => new Response("expired", { status: 403 });

  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });

  const res = createResponse();
  await verifyFollow({
    method: "POST",
    body: {
      file_url: "https://example.com/expired.png",
      expected_handle: "expected",
    },
  }, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), {
    status: "ERROR",
    reason: "Verification service failed",
  });
});
