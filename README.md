## Lull The Tabs

This add-on is designed to unload inactive tabs to free up browser memory. It is the full-featured successor of the BarTab / BarTab Heavy (Tycho) / BarTab Lite (X) extensions family, which uses modern APIs to ensure maximum performance and no conflicts with built-in browser functions and other extensions.

Here is a small comparison table:

|                                   | BarTab Heavy   | BarTab Lite X   | Lull The Tabs |
|-----------------------------------|----------------|-----------------|---------------|
| Hook into Progress Listeners      | on every tab   | on every tab    | **no**        |
| Hook into Web Navigation          | on every tab   | no              | **no**        |
| Hook into Session Manager         | yes            | yes             | **no**        |
| Conflict with "Find in page"      | yes            | no              | **no**        |
| Auto unload inactive tabs         | yes            | no              | **yes**       |
| Prevent background tab loading    | broken         | no              | **yes**       |
| Support wildcard whitelisting     | no             | -               | **yes**       |
| Support IDN in the whitelist      | no             | -               | **yes**       |
| Restartless                       | no             | yes             | **yes**       |

If you used BarTab Heavy (Tycho), then its settings will be automatically imported at the first start. To add a wildcard domain to the exception list, hold down the Ctrl key while clicking on the corresponding context menu. Ctrl+Click on the unload button in the address bar opens extension options.
