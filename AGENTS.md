<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture decisions

- The canonical backend is hardcoded in `src/integrations/supabase/client.ts` (D4_SUPABASE_URL / D4_SUPABASE_ANON_KEY) and must always point at the live Lovable Cloud project — never at a stale or old project ref. Why: the APK and deployed site bypass .env, and mixed URL/key pairs caused "Invalid API key" and login failures.
