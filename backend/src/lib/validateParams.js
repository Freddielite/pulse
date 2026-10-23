// Rejects malformed IDs with a 404 before they reach Postgres, where a
// non-UUID string in a uuid column throws instead of simply matching
// nothing.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidParams(router, names = ["id", "memberId", "eventId"]) {
  for (const name of names) {
    router.param(name, (req, res, next, value) => {
      if (!UUID_RE.test(value)) return res.status(404).json({ error: "not found" });
      next();
    });
  }
}
