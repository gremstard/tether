# Profile pictures and server icons

Cloud Storage is a Blaze feature, and Tether stays on Spark. Images are therefore
stored as base64 strings directly in the Firestore document they belong to:

| Image           | Location                      | Field        |
| --------------- | ----------------------------- | ------------ |
| User avatar     | `users/{uid}`                 | `pfpBase64`  |
| Server icon     | that server's `serverInfo` doc | `iconBase64` |

## Staying under the document limit

A Firestore document is capped at 1 MiB total, and base64 inflates bytes by
about a third. The client therefore never uploads an original file:

1. Downscale to 256×256, cropping to centre rather than squashing, so avatars
   are not distorted.
2. Re-encode as JPEG at quality 0.82.
3. If the result still exceeds the budget, step quality down and retry rather
   than failing the upload outright.
4. Refuse anything still over 400,000 characters.

The 400,000-character ceiling is enforced twice: in the client
([`renderer/profile.js`](../renderer/profile.js)) for a good error message, and
in `firestore.rules` because the client is not trustworthy. It leaves ample room
for the rest of the document under the 1 MiB limit.

A 256×256 JPEG typically lands around 10–20 kB encoded, so the cap is a backstop
for pathological inputs, not a limit users will meet.

## Consequences worth knowing

- Reading a profile always transfers the avatar with it; there is no way to fetch
  one without the other. At profile sizes this is fine, but it is a reason not to
  bulk-read profiles casually.
- There is no CDN and no image URL. The avatar exists only inside the document.
