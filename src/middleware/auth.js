'use strict';
const jwt = require('../utils/jwt');

module.exports = function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: { code: 'NO_TOKEN', message: 'Authorization required' } });
  try {
    const payload = jwt.verify(token);
    req.userId = payload.uid;
    next();
  } catch (e) {
    return res.status(401).json({ error: { code: 'BAD_TOKEN', message: 'Invalid or expired token' } });
  }
};
