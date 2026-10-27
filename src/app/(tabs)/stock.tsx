import React, { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import {
  Badge,
  BigButton,
  Card,
  Chip,
  ErrorState,
  Footer,
  Input,
  Loading,
  Row,
  SectionTitle,
  SecondaryButton,
  T,
  s as base,
  useBottomInset,
} from "../../ui/components";
import { color, space, type, weight } from "../../ui/tokens";
import { MovementStrip } from "../../ui/movement-strip";
import { centred } from "../../ui/layout";
import { searchRank } from "../../domain/search";
import { useQuery } from "../../db/provider";
import { asOfLabel, movementStrip, stockOnHand } from "../../domain/reports";
import { describeStockRow } from "../../domain/stock";
import { formatLocalDate, todayLocal } from "../../domain/time";
import {
  expiringLots,
  lastsLabel,
  loadLedger,
  orderList,
} from "../../domain/supply";

const CAP = 3;
const dosesText = (n: number) => `${n} ${Math.abs(n) === 1 ? "dose" : "doses"}`;
/** "31 Mar", plus the year when it is not this one: "31 Mar 2028". */
const expiryLabel = (date: string, today: string) =>
  date.slice(0, 4) === today.slice(0, 4)
    ? formatLocalDate(date)
    : `${formatLocalDate(date)} ${date.slice(0, 4)}`;

/**
 * ADD STOCK - deliveries in, plus the current position.
 *
 * Teal throughout, and the action reads "ADD STOCK", never "give". This screen
 * moves the ledger in the opposite direction to Give dose, and it sits right
 * next to it in the tab bar, so the visual separation is doing real work.
 */
export default function AddStockScreen() {
  const router = useRouter();
  const bottomInset = useBottomInset();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "low">("all");
  const today = todayLocal();

  const {
    data: rows,
    loading,
    error,
    reload,
  } = useQuery((db) => stockOnHand(db, { activeOnly: true }), []);
  const { data: strip } = useQuery((db) => movementStrip(db, today), [today]);

  const { data: ledger } = useQuery((db) => loadLedger(db), [today]);
  const { data: lots } = useQuery(
    async (db) => expiringLots(db, await loadLedger(db), today),
    [today],
  );
  const [allOrder, setAllOrder] = useState(false);
  const [allSoon, setAllSoon] = useState(false);
  const orders = useMemo(
    () => (rows && ledger ? orderList(rows, ledger, today) : []),
    [rows, ledger, today],
  );

  const decorated = useMemo(
    () => (rows ?? []).map((r) => ({ row: r, d: describeStockRow(r) })),
    [rows],
  );
  // LOW, OUT and CHECK together - everything that wants a decision. Named for
  // what it contains: calling this "low" labelled a shelf with nothing on it as
  // merely running down.
  const lows = decorated.filter((x) => x.d.level !== "OK");

  const shown = useMemo(() => {
    const list =
      filter === "low"
        ? lows
        : [...lows, ...decorated.filter((x) => x.d.level === "OK")];
    if (!q.trim()) return list;
    // Rank the rows, then put the decorations back on in that order.
    const ranked = searchRank(
      list.map((x) => x.row),
      q,
    );
    return ranked.map((row) =>
      list.find((x) => x.row.vaccine_id === row.vaccine_id)!,
    );
  }, [decorated, lows, filter, q]);

  if (error)
    return <ErrorState error={error} onRetry={reload} what="load your stock" />;
  if (loading && !rows) return <Loading label="Loading stock" />;

  // A negative count is a missing delivery, not stock to subtract: it is
  // flagged CHECK on its own row, and must not shrink the total.
  const totalDoses = decorated.reduce(
    (n, x) => n + Math.max(0, x.row.on_hand_doses),
    0,
  );

  return (
    <View style={st.screen}>
      <FlatList
        data={shown}
        keyExtractor={(x) => x.row.vaccine_id}
        contentContainerStyle={[centred, { paddingBottom: 140 + bottomInset }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={st.headerWrap}>
            <T style={st.eyebrow}>{asOfLabel()}</T>
            <T style={st.total}>{dosesText(totalDoses)} in stock</T>

            {strip ? <MovementStrip strip={strip} /> : null}

            {ledger ? (
              <>
                <SectionTitle>
                  {orders.length
                    ? `Order this week · ${orders.length}`
                    : "Order this week"}
                </SectionTitle>
                {orders.length === 0 ? (
                  <T style={st.rowSub}>Nothing to order this week.</T>
                ) : (
                  <Card style={st.flushCard}>
                    {(allOrder ? orders : orders.slice(0, CAP)).map((o) => (
                      <Row
                        dense
                        key={o.vaccine_id}
                        title={o.name}
                        subtitle={
                          o.belowZero
                            ? "Count is below zero. Check deliveries first."
                            : [
                                `${o.onHand} left`,
                                o.perDay === null
                                  ? "not used enough to estimate"
                                  : lastsLabel(o.onHand, o.perDay)?.toLowerCase(),
                              ]
                                .filter(Boolean)
                                .join(" · ")
                        }
                        right={
                          o.belowZero ? (
                            <Badge text="CHECK" tone="danger" />
                          ) : (
                            <T style={st.orderQty}>Order {dosesText(o.order)}</T>
                          )
                        }
                        onPress={() => router.push(`/receive/${o.vaccine_id}`)}
                      />
                    ))}
                    {orders.length > CAP && !allOrder ? (
                      <View>
                        <SecondaryButton
                          accent="stock"
                          label={`Show all ${orders.length}`}
                          onPress={() => setAllOrder(true)}
                        />
                      </View>
                    ) : null}
                  </Card>
                )}

                {lots && lots.length > 0 ? (
                  <>
                    <SectionTitle>{`Use soon · ${lots.length}`}</SectionTitle>
                    <Card style={st.flushCard}>
                      {(allSoon ? lots : lots.slice(0, CAP)).map((l) => (
                        <Row
                          dense
                          key={l.lot_id}
                          title={`${l.name}, batch ${l.lot_number}: use by ${expiryLabel(l.expiry_date, today)}`}
                          subtitle={
                            l.expired
                              ? `${dosesText(l.onHand)} left. Do not use.`
                              : `About ${dosesText(l.onHand)} left.${l.mayWaste ? ` About ${dosesText(l.mayWaste)} may not be used in time.` : ""}`
                          }
                          right={
                            l.expired ? (
                              <Badge text="EXPIRED" tone="danger" />
                            ) : undefined
                          }
                          onPress={() =>
                            router.push(`/receive/${l.vaccine_id}`)
                          }
                        />
                      ))}
                      {lots.length > CAP && !allSoon ? (
                        <View>
                          <SecondaryButton
                            accent="stock"
                            label={`Show all ${lots.length}`}
                            onPress={() => setAllSoon(true)}
                          />
                        </View>
                      ) : null}
                    </Card>
                  </>
                ) : null}
              </>
            ) : null}

            <View style={{ marginTop: space.lg, gap: space.md }}>
              <Input
                placeholder="Search vaccine"
                value={q}
                onChangeText={setQ}
                autoCorrect={false}
                autoCapitalize="none"
              />
              <View style={st.chipRow}>
                <Chip
                  accent="stock"
                  label="All"
                  selected={filter === "all"}
                  onPress={() => setFilter("all")}
                />
                <Chip
                  accent="stock"
                  label={`Low or out (${lows.length})`}
                  selected={filter === "low"}
                  onPress={() => setFilter("low")}
                />
              </View>
            </View>
          </View>
        }
        renderItem={({ item }) => (
          <View style={st.listRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(`/receive/${item.row.vaccine_id}`)}
              style={({ pressed }) => (pressed ? { backgroundColor: color.pressed } : null)}
            >
              <View style={[base.row, base.rowDenseTap]}>
                <View style={st.nameWrap}>
                  <T style={base.rowTitle}>{item.row.name}</T>
                  {item.d.badge ? (
                    <Badge
                      text={item.d.badge}
                      tone={item.d.level === "LOW" ? "low" : "danger"}
                    />
                  ) : null}
                </View>
                <T style={st.count}>{item.d.primary}</T>
                <T style={base.chevron}>›</T>
              </View>
            </Pressable>
          </View>
        )}
      />

      <Footer floating>
        <BigButton
          accent="stock"
          label="Add stock"
          onPress={() => router.push("/receive")}
        />
      </Footer>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  headerWrap: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  eyebrow: {
    fontSize: type.min,
    color: color.textMuted,
    fontWeight: weight.semibold,
  },
  total: {
    fontSize: type.hero,
    fontWeight: weight.bold,
    color: color.text,
    marginTop: 2,
  },
  chipRow: { flexDirection: "row", gap: space.sm, flexWrap: "wrap" },
  listRow: { paddingHorizontal: space.lg, backgroundColor: color.surface },
  nameWrap: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.sm,
  },
  count: {
    fontSize: type.body,
    fontWeight: weight.bold,
    color: color.text,
    textAlign: "right",
    flexShrink: 0,
  },
  flushCard: { paddingVertical: 0 },
  orderQty: {
    fontSize: type.body,
    fontWeight: weight.bold,
    color: color.stock,
  },
  rowSub: { fontSize: type.label, color: color.textMuted, marginTop: 2 },
});
