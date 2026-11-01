# Reactions Worker

The no-sign-in emoji reactions at the end of blog posts (👏 ❤️ 💡 🤯 🔥 🔖). A small
Cloudflare Worker stores one count per emoji per post in Workers KV.

- **Privacy:** IP addresses are never stored. Each reaction keeps only a salted hash of
  (IP, post, emoji) for 30 days, so the same visitor can't add the same emoji twice.
- **Only this site can add reactions:** POSTs from other origins are refused.
- **If the Worker is down,** the reaction bar simply doesn't appear on the post.
- **Cost:** free on Cloudflare's free plan.

## Set it up (Cloudflare dashboard, about 5 minutes)

1. **Create the Worker.** Workers & Pages → Create → Create Worker → name it `reactions` →
   Deploy. Then **Edit code**, replace everything with `worker.js` from this folder, and Deploy.
2. **Create the storage.** Storage & databases → Workers KV → Create namespace → `reactions`.
3. **Connect them.** Your Worker → Settings → Bindings → Add → KV namespace.
   Variable name `REACTIONS`, namespace `reactions`. Deploy.
4. **Add the secret.** Your Worker → Settings → Variables and Secrets → Add → type **Secret**,
   name `SALT`, value: any long random string (for example from a password generator). Deploy.
5. **Give it your domain.** Your Worker → Settings → Domains & Routes → Add → Custom domain →
   `reactions.nithinjohngeorge.com`. Cloudflare creates the DNS record and certificate itself.

Check it: open https://reactions.nithinjohngeorge.com/reactions?post=cgroups-deep-dive-kubernetes.
You should see `{"clap":0,"love":0,...}`.

## Changing the emojis

Edit both lists together:
- `EMOJIS` in `worker.js` (the ids), then redeploy the Worker;
- `reactions.items` in `content/site.json` (id, emoji and label), then push the site.
