class AccessDeniedError extends Error { constructor(m){ super(m); this.name='AccessDeniedError'; } }
exports.AccessDeniedError = AccessDeniedError;
exports.isAccessDeniedError = (e) => e?.name === 'AccessDeniedError';
exports.scopeForPrincipal = (p) => ({ userId: p.kind==='user'?p.userId:undefined, includeLegacy: !!p?.user?.isBootstrapOwner, privileged: !!p?.user?.isBootstrapOwner || p.kind==='admin-token' || p.kind==='dev' });
