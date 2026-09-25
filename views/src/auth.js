// src/auth.js
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.redirect('/admin.html');
}

function requireOwner(req, res, next) {
  if (req.session && req.session.admin && req.session.admin.role === 'owner') return next();
  return res.status(403).render('admin/forbidden', { title: 'Доступ только для владельца' });
}

module.exports = { requireAdmin, requireOwner };
