// Sunsetter: reads your dependency files, looks up end-of-life dates from the free endoflife.date data, and tracks API deprecations.
import { useState } from "react";
import { downloadIcs, localDate } from "./lib/ics";
import { uid, useStored } from "./lib/store";
import { addDays, prettyDate, todayISO } from "./lib/time";
import { Section, Stat, Stats } from "./ui/kit";

const T = "sunsetter";
type Dep = { product: string; version: string; source: string };
type Found = Dep & { cycle: string; eol: string | boolean; latest: string; lts?: boolean; err?: string };
type Manual = { id: string; what: string; date: string; link: string; note: string };
// Package or image names mapped to endoflife.date product ids.
const MAP: Record<string, string> = { node: "nodejs", nodejs: "nodejs", python: "python", react: "react", "react-dom": "react", vue: "vue", "@angular/core": "angular", angular: "angular", django: "django", flask: "flask", rails: "rails", laravel: "laravel", "laravel/framework": "laravel", "spring-boot": "spring-boot", postgres: "postgresql", postgresql: "postgresql", mysql: "mysql", redis: "redis", ubuntu: "ubuntu", debian: "debian", alpine: "alpine", php: "php", golang: "go", go: "go", ruby: "ruby", "eclipse-temurin": "eclipse-temurin", openjdk: "eclipse-temurin", mongo: "mongodb", mongodb: "mongodb", nginx: "nginx", next: "nextjs", nuxt: "nuxt", typescript: "typescript", jquery: "jquery", electron: "electron", dotnet: "dotnet", "mcr.microsoft.com/dotnet/aspnet": "dotnet", elasticsearch: "elasticsearch", kotlin: "kotlin", symfony: "symfony", "symfony/symfony": "symfony", numpy: "numpy", pandas: "pandas", "@nestjs/core": "nestjs", express: "express", tailwindcss: "tailwind-css", bootstrap: "bootstrap" };
const SAMPLE = `package.json
{ "engines": { "node": "16.20" }, "dependencies": { "react": "^17.0.2", "express": "4.18.2", "jquery": "3.6.0" } }

Dockerfile
FROM python:3.8-slim
FROM postgres:12

requirements.txt
django==3.2.18
numpy==1.24.0`;

function detect(text: string): Dep[] {
  const out: Dep[] = [];
  const add = (name: string, v: string, source: string) => { const p = MAP[name.toLowerCase()]; const m = v.match(/(\d+)(?:\.(\d+))?/); if (p && m && !out.some(d => d.product === p)) out.push({ product: p, version: m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1], source }); };
  for (const m of text.matchAll(/"([@\w./-]+)"\s*:\s*"[\^~>=<\s]*(\d+[\d.]*)/g)) add(m[1], m[2], "package.json");
  for (const m of text.matchAll(/^\s*FROM\s+([\w./-]+):(\d[\w.-]*)/gim)) add(m[1], m[2], "Dockerfile");
  for (const m of text.matchAll(/^\s*([\w.-]+)\s*[=~><!]=\s*(\d[\d.]*)/gm)) add(m[1], m[2], "requirements");
  for (const m of text.matchAll(/^\s*(?:python|ruby|nodejs|node|golang|php)\s+(\d[\d.]*)/gim)) add(m[0].trim().split(/\s+/)[0], m[1], ".tool-versions");
  for (const m of text.matchAll(/^\s*go\s+(\d+\.\d+)/gm)) add("go", m[1], "go.mod");
  for (const m of text.matchAll(/"([\w-]+\/[\w-]+)"\s*:\s*"[\^~>=<\s]*(\d[\d.]*)/g)) add(m[1], m[2], "composer.json");
  return out;
}
/** Pick the release cycle that matches a version: exact "3.8" first, then the major version. */
async function lookup(d: Dep): Promise<Found> {
  try {
    const cycles: { cycle: string; eol: string | boolean; latest: string; lts?: boolean | string }[] = await (await fetch(`https://endoflife.date/api/${d.product}.json`)).json();
    const [maj, min] = d.version.split(".");
    const c = cycles.find(x => x.cycle === `${maj}.${min}`) ?? cycles.find(x => x.cycle === maj) ?? cycles.find(x => x.cycle.startsWith(maj + "."));
    return c ? { ...d, cycle: c.cycle, eol: c.eol, latest: cycles[0].latest ?? cycles[0].cycle, lts: !!c.lts } : { ...d, cycle: "?", eol: false, latest: cycles[0]?.latest ?? "", err: "Version not listed" };
  } catch { return { ...d, cycle: "?", eol: false, latest: "", err: "Could not reach endoflife.date" }; }
}

export default function Sunsetter() {
  const [text, setText] = useStored(T, "text", SAMPLE);
  const [found, setFound] = useStored<Found[]>(T, "found", []);
  const [manual, setManual] = useStored<Manual[]>(T, "manual", [
    { id: "m1", what: "Google Maps JavaScript API: Marker class", date: "2027-02-21", link: "https://developers.google.com/maps/deprecations", note: "Move to AdvancedMarkerElement" },
    { id: "m2", what: "Stripe API version 2022-08-01", date: addDays(todayISO(), 120), link: "https://stripe.com/docs/upgrades", note: "Pin a newer version and test webhooks" },
  ]);
  const [busy, setBusy] = useState(false);
  const [m, setM] = useState({ what: "", date: addDays(todayISO(), 90), link: "", note: "" });
  const deps = detect(text);
  const days = (d: string) => Math.round((new Date(d).getTime() - new Date(todayISO()).getTime()) / 86400000);
  const status = (f: Found): [string, string, number] => { if (f.err) return [f.err, "", 9999]; if (f.eol === true) return ["End of life", "bad", -1]; if (!f.eol) return ["Supported", "good", 9998]; const d = days(f.eol as string); return d < 0 ? [`Ended ${prettyDate(f.eol as string)}`, "bad", d] : d < 180 ? [`Ends in ${d} days`, "warn", d] : [`Ends ${prettyDate(f.eol as string)}`, "good", d]; };
  const rows = [...found].sort((a, b) => status(a)[2] - status(b)[2]);
  const check = async () => { setBusy(true); setFound(await Promise.all(deps.map(lookup))); setBusy(false); };
  const soon = rows.filter(r => status(r)[1] !== "good" && !r.err).length + manual.filter(x => days(x.date) < 180).length;

  return (
    <div className="stack">
      <Section title="What's going out of support" aside={<button className="btn small" onClick={() => downloadIcs("sunsets.ics", [...rows.filter(r => typeof r.eol === "string" && days(r.eol) > 0).flatMap(r => [{ title: `${r.product} ${r.cycle} end of life`, start: localDate(r.eol as string), allDay: true }, { title: `Plan upgrade: ${r.product} ${r.cycle} ends in 90 days`, start: localDate(addDays(r.eol as string, -90)), allDay: true }]), ...manual.map(x => ({ title: `Deprecation: ${x.what}`, start: localDate(x.date), allDay: true, description: `${x.note} ${x.link}` }))], "Sunsets")}>Warnings to calendar</button>}>
        <Stats><Stat value={deps.length} label="Runtimes and frameworks found" /><Stat value={rows.filter(r => status(r)[1] === "bad").length} label="Already unsupported" tone="bad" /><Stat value={soon} label="Need attention within 6 months" tone="warn" /><Stat value={manual.length} label="API deprecations tracked" /></Stats>
      </Section>
      <div className="grid2">
        <Section title="Your dependency files">
          <label className="field"><span>Paste package.json, requirements.txt, Dockerfile, go.mod, composer.json or .tool-versions (several at once is fine)</span><textarea id="su-t" className="input" rows={10} value={text} onChange={e => setText(e.target.value)} style={{ fontFamily: "var(--mono)", fontSize: 12 }} /></label>
          <div className="row" style={{ marginTop: 8, alignItems: "center" }}><button className="btn primary" onClick={check} disabled={!deps.length || busy}>{busy ? "Checking…" : `Check ${deps.length} items`}</button><span className="note">{deps.map(d => `${d.product} ${d.version}`).join(", ")}</span></div>
        </Section>
        <Section title="Results">
          {rows.length === 0 ? <p className="empty-note">Press “Check” to look up end-of-life dates.</p> : <div className="table-wrap"><table className="t"><thead><tr><th>What</th><th>You use</th><th>Latest</th><th>Status</th></tr></thead>
            <tbody>{rows.map(r => { const s = status(r); return <tr key={r.product}><td><a href={`https://endoflife.date/${r.product}`} target="_blank" rel="noreferrer">{r.product}</a><br /><span className="note">{r.source}</span></td><td className="num">{r.version}{r.lts ? " LTS" : ""}</td><td className="num">{r.latest}</td><td><span className={"pill " + s[1]}>{s[0]}</span></td></tr>; })}</tbody></table></div>}
          <p className="note" style={{ marginTop: 8 }}>Data from endoflife.date, a free community-maintained source.</p>
        </Section>
      </div>
      <Section title="Third-party API deprecations">
        {manual.sort((a, b) => a.date.localeCompare(b.date)).map(x => { const d = days(x.date); return <div key={x.id} className="row" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)", alignItems: "center" }}><div style={{ flex: 1 }}><strong>{x.what}</strong><p className="note">{x.note} {x.link && <a href={x.link} target="_blank" rel="noreferrer">notice</a>}</p></div><span className={"pill " + (d < 0 ? "bad" : d < 90 ? "bad" : d < 180 ? "warn" : "good")}>{d < 0 ? "Past" : `${d} days`}</span><button className="btn ghost small danger" onClick={() => setManual(manual.filter(y => y.id !== x.id))}>×</button></div>; })}
        <form className="row" style={{ marginTop: 10, alignItems: "flex-end" }} onSubmit={e => { e.preventDefault(); if (!m.what.trim()) return; setManual([...manual, { id: uid(), ...m }]); setM({ ...m, what: "", link: "", note: "" }); }}>
          <label className="field" style={{ flexGrow: 2 }}><span>API or feature</span><input className="input" value={m.what} onChange={e => setM({ ...m, what: e.target.value })} /></label>
          <label className="field"><span>Shutdown date</span><input type="date" className="input" value={m.date} onChange={e => setM({ ...m, date: e.target.value })} /></label>
          <label className="field"><span>Notice link</span><input className="input" value={m.link} onChange={e => setM({ ...m, link: e.target.value })} /></label>
          <label className="field"><span>What to do</span><input className="input" value={m.note} onChange={e => setM({ ...m, note: e.target.value })} /></label>
          <button className="btn small" type="submit">Track</button>
        </form>
      </Section>
    </div>
  );
}
