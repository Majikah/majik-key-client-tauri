# @majikah/majik-key-client-tauri

TypeScript facade over `tauri-plugin-majik-key-client`.

```ts
import { MajikKeyClientTauri } from "@majikah/majik-key-client-tauri";

const majik = await MajikKeyClientTauri.open({
  onUnlockRequested: async (accountId) => askUserForPassphrase(accountId), // null = cancelled
});

majik.getActiveAccount();                       // synchronous, from the read-model
majik.on("active-account-change", ({ active }) => { /* ... */ });
await majik.createAccount({ mnemonic, passphrase, label: "Main" });
await majik.unlockAccount(id, passphrase);
```

- Getters are synchronous (read-model refreshed after every mutation and every Rust event);
  actions are async. Errors are `MajikKeyClientError` with `.kind` (e.g. `"unlockRequired"`).
- Subclass for the signature client: `class MajikSignatureClientTauri extends MajikKeyClientTauri`,
  use `this.invoke()` / `this.mutate()`, and pass `{ plugin: "majik-signature-client", eventChannel }`.
- `contract/scenario.json` is the wire contract (the TS test checks the facade sends exactly these
  args; replay the same file against the Rust plugin in your own test).
- `npm run typecheck && npm test && npm run build`


---

## License

**License:** [Apache-2.0](LICENSE) — free for personal and commercial use.

## Author

Developed by **Josef Elijah Fabian (Zelijah)** | [Majikah Solutions OPC](https://majikah.solutions/about)


**Developer**: [Josef Elijah Fabian](https://github.com/jedlsf)

**GitHub**: [https://github.com/Majikah](https://github.com/Majikah)

**Project Repository**: [https://github.com/Majikah/majik-key-client-tauri](https://github.com/Majikah/majik-key-client-tauri)

**Technical Whitepaper**: [https://zenodo.org/records/23208491](https://zenodo.org/records/23208491)

---

## Contact

- **Business Email**: [business@majikah.solutions](mailto:business@majikah.solutions)
- **Official Website**: [https://www.thezelijah.world](https://www.thezelijah.world)
- **Majikah Ecosystem**: [https://majikah.solutions](https://majikah.solutions)