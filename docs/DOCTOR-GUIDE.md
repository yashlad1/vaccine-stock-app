# Clinic Stock — how to use it

This app replaces the vaccine stock notebook.

Everything stays on the phone. No internet is needed.

There are 4 tabs at the top. You will use the first two every day.

---

## The app in one picture

```mermaid
flowchart TD
    OPEN([Open the app]) --> HOME

    HOME["<b>Give dose</b><br/>The app opens here.<br/>Every vaccine is a big box.<br/>Under each name is how many doses are left."]

    HOME -->|"Giving a vaccine to a child"| D1
    HOME -->|"New stock has come"| S1
    HOME -->|"Add or remove a vaccine"| V1
    HOME -->|"Reports and backup"| M1

    subgraph GIVE ["Give a vaccine — 3 taps"]
        direction TB
        D1["1. Tap the vaccine box"] --> D2["2. Tap the child's name<br/>or tap <b>Skip, no name</b>"]
        D2 --> D3(["3. Tap <b>Give 1 dose</b>"])
        D3 --> D4["The count goes down at once.<br/>Wrong tap? Tap <b>Undo</b>."]
    end

    subgraph ADD ["New stock has come"]
        direction TB
        S1["1. Tap <b>Add stock</b> at the top"] --> S2["2. Tap the vaccine"]
        S2 --> S3["3. Type the batch number<br/>written on the box"]
        S3 --> S4["4. Roll the wheels to the<br/>expiry month and year"]
        S4 --> S5["5. Tap − or + for how many<br/>vials have come"]
        S5 --> S6(["6. Tap <b>Add to stock</b>"])
    end

    subgraph CAT ["Vaccines"]
        direction TB
        V1["Tap <b>Vaccines</b> at the top"] --> V2["To add one:<br/><b>Add a new vaccine</b> at the bottom"]
        V1 --> V3["To stop using one:<br/>tap <b>Hide</b> or <b>Remove</b>"]
    end

    subgraph MORE ["More"]
        direction TB
        M1["Tap <b>More</b> at the top"] --> M2["<b>Given today</b><br/>every dose, with time"]
        M1 --> M3["<b>Back up / restore</b><br/>save a copy"]
        M1 --> M4["<b>Missing child names</b><br/>add names you skipped"]
        M1 --> M5["<b>All entries</b><br/>full history, and fix mistakes"]
    end

    style HOME fill:#DBEAFE,stroke:#1D4ED8,stroke-width:2px
    style D3 fill:#DBEAFE,stroke:#1D4ED8,stroke-width:2px
    style S6 fill:#CCFBF1,stroke:#0F766E,stroke-width:2px
    style OPEN fill:#F1F5F9,stroke:#475569
```

---

## How to install it

1. Tap the link.
2. Let it download.
3. The phone will say it is not from the Play Store. Tap **More details**, then **Install anyway**.
4. Open **Clinic Stock**.

It asks only the first time.

---

## Do this once, before you start

**1. Check the doses per vial.**

Tap **Vaccines**. Look at each vial you use. Check that the doses per vial matches the real vial in
your fridge.

This number is used for every count. If it is wrong, every total for that vaccine will be wrong.

**2. Put in what you have now.**

Tap **Add stock**. Add what is in the fridge today, one vaccine at a time.

**3. Take one backup.**

Tap **More**, then **Back up / restore**, then **Back up now**. Send the file to yourself on
WhatsApp. Now you have seen it work once.

---

## Giving a vaccine

1. Tap the vaccine box.
2. Tap the child's name. Or type 2 letters to find it. Or tap **Skip, no name**.
3. Tap **Give 1 dose**.

The count goes down at once.

If you tapped wrong, a black bar comes up at the bottom. Tap **Undo** on it.

You do not have to type the batch. It is already filled in.

### The child's age

1. Tap the child's name. For a new child, type the name and tap **+ Add**.
2. Roll the three wheels to the day, month and year of birth.
3. Tap **Give 1 dose**.

The age shows on every dose. Next time it fills in by itself.

---

## When new stock comes

1. Tap **Add stock** at the top.
2. Tap the vaccine.
3. Type the batch number from the box.
4. Roll the wheels to the expiry month and year.
5. Tap **Bought** or **Government (free)**.
6. Tap **−** or **+** for how many vials have come.
7. Tap **Add to stock**.

You do not have to multiply. The app does it.

---

## The colours

**Blue** takes stock out. **Green** puts stock in.

If the screen is the wrong colour, you are on the wrong tab.

| On the box | Meaning |
| --- | --- |
| **18 doses** in black | Fine |
| **LOW** in yellow | Very few left |
| **OUT** in red | None left |
| **CHECK** in red | The count went below zero. Some stock was not put in. |

Every warning has a word, not just a colour.

---

## Good to know

**The child's name is not needed.** Never stop because you do not have it. Tap **Skip, no name**.
Add it later from **MORE → Missing child names**.

**Nothing is ever deleted.** If you fix a mistake, the app adds a correction next to it. The old
entry stays. So you can fix a mistake weeks later.

**A LOW or OUT warning never stops you.** The app will always let you record a vaccine.

**Expiry means the end of that month.** A vial marked 03/2027 can be used until 31 March 2027. The
app writes the last date under the wheels.

---

## If something looks wrong

**A number looks wrong** — Tap **More**, then **All entries**. Every entry is there, newest first.
Tap **Correct this entry** on the wrong one.

**A red message comes up** — Read it. It always tells you if anything was saved. If it says nothing
was saved, then nothing was saved.

**A yellow bar asks you to back up** — Tap **Back up**. Or tap **Later** to be asked tomorrow.

**Anything else** — Send a photo of the screen on WhatsApp. Also send a backup file if you can.

---

## Backups

The records are on this phone. Back it up when the app asks.

Tap **More** → **Back up / restore** → **Back up now**.

It makes one small file. Send it to yourself on WhatsApp, or save it to Drive. It takes a few
seconds.

If the phone is lost or changed, that file puts everything back.
