export function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: "not authenticated" });
  req.userId = req.session.userId;
  next();
}
