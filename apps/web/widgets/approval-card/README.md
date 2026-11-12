# Approval cards

Every pending founder approval: the intent (action, amount, envelope, payee, agent), the rule that fired, the agent's
reason and evidence links, with **Approve** / **Deny**. The buttons call a Next.js server action passed in Studio's
`context`; the API calls the gate, which re-checks every deny rule before executing. No keys reach the browser.
Reads the boardroom store (updated by the 15 s live refresh).
