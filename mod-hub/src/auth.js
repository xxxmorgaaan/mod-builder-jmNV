// src/auth.js
// Иерархия ролей в админке — чем выше уровень, тем больше доступа:
//
//   Владелец (owner, 4)             — всё, включая создание/удаление старших админов
//   Старший админ (senior_admin, 3) — почти как владелец: бэкапы/восстановление,
//                                     управление админами и модерами, счётчик посещений;
//                                     НЕ может трогать владельца и других старших админов
//   Админ (admin, 2)                — управление модами (теги, скрытие, удаление,
//                                     счётчики, коды), баны пользователей и IP
//   Модер (moderator, 1)            — проверка модов и версий, баг-репорты, жалобы
//
// Проверять моды (очередь модерации) может любой уровень.
const ROLE_LEVELS = { moderator: 1, admin: 2, senior_admin: 3, owner: 4 };
const ROLE_LABELS = { moderator: 'Модер', admin: 'Админ', senior_admin: 'Старший админ', owner: 'Владелец' };

function levelOf(role) {
  return ROLE_LEVELS[role] || 0;
}

function adminLevel(req) {
  return levelOf(req.session && req.session.admin && req.session.admin.role);
}

/** Любой вошедший админ (все уровни) — например, очередь модерации. */
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.redirect('/admin.html');
}

/** Middleware «этот уровень и выше». */
function requireLevel(minRole) {
  const min = levelOf(minRole);
  return (req, res, next) => {
    if (!(req.session && req.session.admin)) return res.redirect('/admin.html');
    if (adminLevel(req) >= min) return next();
    return res.status(403).render('admin/forbidden', { title: `Доступ только для роли «${ROLE_LABELS[minRole]}» и выше` });
  };
}

const requireAdminLevel = requireLevel('admin');
const requireSeniorAdmin = requireLevel('senior_admin');
const requireOwner = requireLevel('owner');

module.exports = {
  requireAdmin, requireAdminLevel, requireSeniorAdmin, requireOwner,
  ROLE_LEVELS, ROLE_LABELS, levelOf, adminLevel,
};
