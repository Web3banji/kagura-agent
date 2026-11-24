function canSee(s, scope){ if(scope.privileged) return true; if(s.userId==null) return !!scope.includeLegacy; return scope.userId===s.userId; }
exports.getStoryById = async (id, scope) => { const stories = globalThis.__testStories; const s=stories.get(id); return s && canSee(s,scope) ? structuredClone(s) : undefined; };
exports.upsertStory = async (storyIn, scope) => {
  const stories = globalThis.__testStories;
  const existing = stories.get(storyIn.id);
  if (existing) {
    if (!canSee(existing, scope)) throw Object.assign(new Error('Access denied'), {name:'AccessDeniedError'});
    if (!scope.privileged) {
      if ((storyIn.userId??null)!==(existing.userId??null)) throw Object.assign(new Error('Cannot change the owner of an existing story'), {name:'AccessDeniedError'});
      if ((storyIn.projectId??null)!==(existing.projectId??null)) throw Object.assign(new Error('Cannot change the project of an existing story'), {name:'AccessDeniedError'});
    }
    const merged = { ...storyIn, userId: existing.userId, projectId: scope.privileged ? (storyIn.projectId??existing.projectId??null) : (existing.projectId??null) };
    stories.set(storyIn.id, merged); return structuredClone(merged);
  }
  const created = scope.privileged ? storyIn : { ...storyIn, userId: scope.userId ?? null };
  stories.set(created.id, created); return structuredClone(created);
};
