const { sendJson, setCors } = require("./_http");

module.exports = function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return sendJson(res, 405, { ok: false });
  }

  return sendJson(res, 200, { ok: true });
};
