// Express 4 does not catch rejected promises from async route handlers.
// Before this existed, any thrown error in an async handler (a bad UUID
// in a URL, a dropped DB connection) became an unhandled rejection, which
// crashes the process on Node 15+ and leaves the request hanging until
// then. This patches Layer so a rejection is forwarded to next(err) and
// lands in the error handler in index.js instead.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Layer = require("express/lib/router/layer");

const original = Layer.prototype.handle_request;
Layer.prototype.handle_request = function handleRequest(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return next();
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === "function") result.catch(next);
  } catch (err) {
    next(err);
  }
};
Layer.prototype.handle_request.__original = original;
