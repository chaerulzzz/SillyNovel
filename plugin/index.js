/**
 * SillyNovel — server plugin
 *
 * Mounted by SillyTavern at /api/plugins/sillynovel (requires
 * `enableServerPlugins: true` in config.yaml).
 *
 * STATUS: scaffold. No storage routes exist yet — project/chapter CRUD lands
 * in Phase 2. See docs/PLAN.md.
 *
 * The Phase 1.5 integration spike (server-generated UUIDs, atomic writes,
 * cross-user isolation, CSRF/auth behavior, hostile-identifier rejection)
 * was implemented, tested, and removed per docs/PLAN.md's "spike routes are
 * production-shaped" — deletion is the only reliable guarantee a test
 * endpoint never ships. Full results in docs/PROGRESS.md.
 *
 * ⚠️ SECURITY (see AGENTS.md — these are not negotiable):
 *  - NEVER reconstruct a user's filesystem path from a session handle. Use the
 *    authenticated `request.user.directories` object ST's middleware provides.
 *    If it is absent, that is a BLOCKER — stop, do not work around it.
 *  - NEVER interpolate route params into a path. Server-generated UUIDs only,
 *    strict validation, and re-check every resolved path stays under the
 *    user's own directory.
 *
 * NOTE: plugin changes require a CONTAINER RESTART (Node loads plugins at
 * boot). Extension changes only need a browser reload.
 */

export const info = {
    id: 'sillynovel',
    name: 'SillyNovel',
    description: 'Project and chapter storage for the SillyNovel Writing Workspace.',
};

/**
 * @param {import('express').Router} router mounted at /api/plugins/sillynovel
 */
export async function init(router) {
    // Liveness check — confirms the plugin loaded and routes are mounted.
    router.get('/health', (_req, res) => {
        res.json({ ok: true, plugin: info.id, version: '0.0.1' });
    });

    console.log('[sillynovel] server plugin loaded (scaffold)');
}

export async function exit() {
    console.log('[sillynovel] server plugin unloaded');
}

export default { info, init, exit };
