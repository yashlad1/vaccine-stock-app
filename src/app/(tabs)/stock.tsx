import React, { useMemo, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
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
  usageRate,
} from "../../domain/supply";

const CAP = 3;

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

  const totalDoses = decorated.reduce((n, x) => n + x.row.on_hand_doses, 0);

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
            <T style={st.total}>{totalDoses} doses in stock</T>

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
                                lastsLabel(o.onHand, o.perDay)?.toLowerCase(),
                              ]
                                .filter(Boolean)
                                .join(" · ")
                        }
                        right={
                          o.belowZero ? (
                            <Badge text="CHECK" tone="danger" />
                          ) : (
                            <T style={st.orderQty}>Order {o.order}</T>
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
                    <T style={[st.rowSub, st.note]}>
                      Enough for 4 weeks, based on the last 8 weeks. Check the
                      fridge first.
                    </T>
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
                          title={`${l.name}, batch ${l.lot_number}: use by ${formatLocalDate(l.expiry_date)}`}
                          subtitle={
                            l.expired
                              ? `${l.onHand} doses left. Do not use.`
                              : `About ${l.onHand} doses left.${l.mayWaste ? ` About ${l.mayWaste} may not be used in time.` : ""}`
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
        renderItem={({ item }) => {
          const lasts = ledger
            ? lastsLabel(
                item.row.on_hand_doses,
                usageRate(ledger, item.row.vaccine_id, today),
              )
            : null;
          const limit = item.row.min_balance_doses;
          return (
            <View style={st.listRow}>
              <Row
                dense
                title={item.row.name}
                subtitle={[
                  item.d.primary,
                  limit > 0
                    ? `Safety limit ${limit} ${limit === 1 ? "dose" : "doses"}`
                    : null,
                  lasts,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                right={
                  item.d.badge ? (
                    <Badge
                      text={item.d.badge}
                      tone={item.d.level === "LOW" ? "low" : "danger"}
                    />
                  ) : undefined
                }
                onPress={() => router.push(`/receive/${item.row.vaccine_id}`)}
              />
            </View>
          );
        }}
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
  flushCard: { paddingVertical: 0 },
  note: { paddingBottom: space.sm },
  orderQty: {
    fontSize: type.body,
    fontWeight: weight.bold,
    color: color.stock,
  },
  rowSub: { fontSize: type.label, color: color.textMuted, marginTop: 2 },
});
