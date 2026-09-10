import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  Alert, RefreshControl, Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { format } from 'date-fns';
import { sendGroupSingil } from '../lib/api';
import AppModal from '../components/AppModal';

const PAYMENT_METHODS = ['GCash', 'Maya', 'BDO', 'BPI', 'Cash', 'Other'];

export default function GroupDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();

  const [group, setGroup] = useState<any>(null);
  const [participants, setParticipants] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sendingSingil, setSendingSingil] = React.useState<string | null>(null);

  // Record Payment modal
  const [showPayModal, setShowPayModal] = useState(false);
  const [payingParticipant, setPayingParticipant] = useState<any>(null);
  const [payAmount, setPayAmount] = useState('');
  const [selectedPayMethod, setSelectedPayMethod] = useState('GCash');

  const [showErrorModal, setShowErrorModal] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const [showSingilConfirm, setShowSingilConfirm] = useState(false);
  const [singilTarget, setSingilTarget] = useState<any>(null);

  const [showSingilResult, setShowSingilResult] = useState(false);
  const [singilResultOk, setSingilResultOk] = useState(true);
  const [singilResultMsg, setSingilResultMsg] = useState('');

  const showError = (msg: string) => {
    setErrorMsg(msg);
    setShowErrorModal(true);
  };

  const loadData = async () => {
    const { data: groupData } = await supabase
      .from('group_expenses')
      .select('*, payer:payer_id(full_name, email)')
      .eq('id', id)
      .single();
    const { data: participantData } = await supabase
      .from('group_participants')
      .select('*, participant:participant_id(full_name, email)')
      .eq('group_expense_id', id)
      .order('created_at');
    setGroup(groupData);
    setParticipants(participantData || []);
    setLoading(false);
  };

  useEffect(() => { loadData(); }, [id]);
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };
  const isPayer = group?.payer_id === user?.id;

  const remainingFor = (p: any) => Math.max(Number(p.share_amount) - Number(p.amount_paid || 0), 0);
  const isFullyPaid = (p: any) => Number(p.amount_paid || 0) >= Number(p.share_amount);
  const isPartiallyPaid = (p: any) => Number(p.amount_paid || 0) > 0 && !isFullyPaid(p);

  // Open the record payment modal
  const openPayModal = (participant: any) => {
    setPayingParticipant(participant);
    setPayAmount(String(remainingFor(participant)));
    setSelectedPayMethod(group?.payment_method || 'GCash');
    setShowPayModal(true);
  };

  // Confirm and record a (possibly partial) payment
  const confirmRecordPayment = async () => {
    if (!payingParticipant) return;
    const amount = parseFloat(payAmount);
    if (isNaN(amount) || amount <= 0) { showError('Enter a valid amount.'); return; }

    const remaining = remainingFor(payingParticipant);
    if (amount > remaining) {
      showError(`Amount exceeds remaining balance of ₱${remaining.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`);
      return;
    }

    const newAmountPaid = Number(payingParticipant.amount_paid || 0) + amount;
    const nowFullyPaid = newAmountPaid >= Number(payingParticipant.share_amount);

    // Log the payment
    await supabase.from('group_participant_payments').insert({
      group_participant_id: payingParticipant.id,
      amount,
      payment_date: new Date().toISOString().split('T')[0],
      payment_method: selectedPayMethod,
      recorded_by: user!.id,
    });

    // Update the participant's running total
    await supabase
      .from('group_participants')
      .update({
        amount_paid: newAmountPaid,
        is_paid: nowFullyPaid,
        paid_at: nowFullyPaid ? new Date().toISOString() : payingParticipant.paid_at,
      })
      .eq('id', payingParticipant.id);

    // Check if all participants are now fully paid — auto-settle group
    const updated = participants.map((p) =>
      p.id === payingParticipant.id ? { ...p, amount_paid: newAmountPaid } : p
    );
    const allPaid = updated.every((p) => Number(p.amount_paid || 0) >= Number(p.share_amount));
    if (allPaid) {
      await supabase.from('group_expenses').update({ status: 'settled' }).eq('id', id);
    }

    setShowPayModal(false);
    setPayingParticipant(null);
    setPayAmount('');
    loadData();
  };

  const handleSingil = (participant: any) => {
    setSingilTarget(participant);
    setShowSingilConfirm(true);
  };

  const confirmSendGroupSingil = async () => {
    const participant = singilTarget;
    setShowSingilConfirm(false);
    if (!participant || sendingSingil === participant.id) return;

    setSendingSingil(participant.id);
    const { data: payerProfile } = await supabase
      .from('users').select('full_name, email').eq('id', user!.id).single();
    const remaining = remainingFor(participant);
    const { data: notif } = await supabase.from('email_notifications').insert({
      recipient_email: participant.participant?.email,
      subject_email: `Group Expense Reminder: ₱${remaining} for ${group?.title}`,
      notification_type: 'group_singil',
      subject_cost_id: group?.id,
      status: 'pending',
    }).select().single();
    const result = await sendGroupSingil({
      recipient_email: participant.participant?.email,
      payer_name: payerProfile?.full_name || payerProfile?.email || 'Your friend',
      group_title: group?.title,
      share_amount: remaining,
      payment_method: group?.payment_method,
      payment_details: group?.payment_details,
      notification_id: notif?.id,
    });
    setSendingSingil(null);
    setSingilResultOk(result.success);
    setSingilResultMsg(result.success ? 'Singil email sent.' : (result.error ?? 'Could not send email.'));
    setShowSingilResult(true);
  };

  const formatCurrency = (n: number) =>
    `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

  const fullyPaidCount = participants.filter((p) => isFullyPaid(p)).length;
  const totalCollected = participants.reduce((s, p) => s + Number(p.amount_paid || 0), 0);

  const styles = makeStyles(colors);

  if (loading) {
    return <View style={styles.center}><Text style={styles.loadingText}>Loading...</Text></View>;
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, group?.status === 'settled' && { backgroundColor: colors.success }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{group?.title}</Text>
        <View style={{ width: 38 }} />
      </View>

      <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
        {/* Summary Card */}
        <View style={styles.summaryCard}>
          <View style={styles.summaryRow}>
            <View>
              <Text style={styles.summaryLabel}>Total Amount</Text>
              <Text style={styles.summaryAmount}>{formatCurrency(group?.total_amount)}</Text>
            </View>
            <View style={[styles.statusBadge, {
              backgroundColor: group?.status === 'settled' ? colors.success + '25' : colors.warning + '25',
            }]}>
              <Text style={[styles.statusText, {
                color: group?.status === 'settled' ? colors.success : colors.warning,
              }]}>
                {group?.status === 'settled' ? 'Settled' : 'Active'}
              </Text>
            </View>
          </View>

          {/* Meta info */}
          <View style={styles.metaRow}>
            {[
              { label: 'Date', value: group?.expense_date ? format(new Date(group.expense_date), 'MMM d, yyyy') : '—' },
              { label: 'Category', value: group?.category },
              { label: 'Split', value: group?.split_method === 'equal' ? 'Equal' : 'Custom' },
              { label: 'Paid by', value: group?.payer?.full_name || group?.payer?.email },
            ].map((item) => (
              <View key={item.label} style={styles.metaItem}>
                <Text style={styles.metaLabel}>{item.label}</Text>
                <Text style={styles.metaValue}>{item.value}</Text>
              </View>
            ))}
          </View>

          {/* Payment info */}
          {(group?.payment_method || group?.payment_details) && (
            <View style={styles.paymentInfoRow}>
              <Ionicons name="card-outline" size={14} color={colors.textSecondary} />
              <Text style={styles.paymentInfoText}>
                Pay via {group?.payment_method}
                {group?.payment_details ? ` · ${group.payment_details}` : ''}
              </Text>
            </View>
          )}

          {/* Progress */}
          <View style={styles.progressSection}>
            <View style={styles.progressHeader}>
              <Text style={styles.progressLabel}>{fullyPaidCount}/{participants.length} fully paid</Text>
              <Text style={styles.progressAmount}>{formatCurrency(totalCollected)} collected</Text>
            </View>
            <View style={styles.progressBg}>
              <View style={[styles.progressFill, {
                width: group?.total_amount > 0
                  ? `${Math.min((totalCollected / Number(group.total_amount)) * 100, 100)}%` as any
                  : '0%',
              }]} />
            </View>
          </View>
        </View>

        {/* Participants */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Participants</Text>
          {participants.length === 0 ? (
            <Text style={styles.emptyText}>No participants added.</Text>
          ) : (
            participants.map((p) => {
              const fullyPaid = isFullyPaid(p);
              const partiallyPaid = isPartiallyPaid(p);
              const remaining = remainingFor(p);
              const pct = Number(p.share_amount) > 0
                ? Math.min((Number(p.amount_paid || 0) / Number(p.share_amount)) * 100, 100)
                : 0;
              return (
                <View key={p.id} style={[styles.participantCard, fullyPaid && styles.participantPaid]}>
                  <View style={styles.participantTopRow}>
                    <View style={styles.participantLeft}>
                      <View style={[styles.avatar, {
                        backgroundColor: fullyPaid ? colors.success + '25' : colors.ambaganLedger + '25',
                      }]}>
                        <Text style={[styles.avatarText, {
                          color: fullyPaid ? colors.success : colors.ambaganLedger,
                        }]}>
                          {(p.participant?.full_name || p.participant?.email || '?')[0].toUpperCase()}
                        </Text>
                      </View>
                      <View style={{ marginLeft: 12 }}>
                        <Text style={styles.participantName}>
                          {p.participant?.full_name || p.participant?.email}
                        </Text>
                        <Text style={styles.participantEmail}>{p.participant?.email}</Text>
                        {fullyPaid && p.paid_at && (
                          <Text style={styles.paidAt}>
                            Paid {format(new Date(p.paid_at), 'MMM d, yyyy')}
                          </Text>
                        )}
                      </View>
                    </View>
                    <View style={styles.participantRight}>
                      <Text style={[styles.shareAmount, fullyPaid && { color: colors.success }]}>
                        {formatCurrency(p.share_amount)}
                      </Text>
                      {fullyPaid ? (
                        <View style={styles.paidBadge}>
                          <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                          <Text style={styles.paidText}>Paid</Text>
                        </View>
                      ) : partiallyPaid ? (
                        <View style={styles.partialBadge}>
                          <Text style={styles.partialText}>Partial</Text>
                        </View>
                      ) : (
                        <View style={styles.pendingBadge}>
                          <Text style={styles.pendingText}>Pending</Text>
                        </View>
                      )}
                    </View>
                  </View>

                  {/* Per-participant progress, shown once anything has been paid */}
                  {(partiallyPaid || fullyPaid) && (
                    <View style={styles.participantProgressSection}>
                      <View style={styles.participantProgressBg}>
                        <View style={[styles.participantProgressFill, {
                          width: `${pct}%` as any,
                          backgroundColor: fullyPaid ? colors.success : colors.warning,
                        }]} />
                      </View>
                      <Text style={styles.participantProgressText}>
                        {formatCurrency(p.amount_paid || 0)} of {formatCurrency(p.share_amount)}
                        {!fullyPaid ? ` · ${formatCurrency(remaining)} left` : ''}
                      </Text>
                    </View>
                  )}

                  {!fullyPaid && (
                    <View style={styles.actionRow}>
                      {isPayer && (
                        <TouchableOpacity style={styles.recordPayBtn} onPress={() => openPayModal(p)}>
                          <Ionicons name="cash-outline" size={14} color="#fff" />
                          <Text style={styles.recordPayText}>Record Payment</Text>
                        </TouchableOpacity>
                      )}
                      {isPayer && (
                        <TouchableOpacity
                          style={[styles.singilBtn, sendingSingil === p.id && { opacity: 0.5 }]}
                          onPress={() => handleSingil(p)}
                          disabled={sendingSingil === p.id}
                        >
                          <Ionicons name="mail-outline" size={14} color={colors.secondary} />
                          <Text style={styles.singilText}>
                            {sendingSingil === p.id ? 'Sending...' : 'Singil'}
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                </View>
              );
            })
          )}
        </View>
        <View style={{ height: 32 }} />
      </ScrollView>

      {/* Record Payment Modal */}
      <Modal visible={showPayModal} animationType="slide" transparent>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.modal}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Record Payment</Text>
              <TouchableOpacity onPress={() => setShowPayModal(false)} style={styles.closeBtn}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {payingParticipant && (
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                {/* Who's paying */}
                <View style={styles.payConfirmCard}>
                  <View style={styles.payConfirmLeft}>
                    <View style={[styles.avatar, { backgroundColor: colors.ambaganLedger + '25' }]}>
                      <Text style={[styles.avatarText, { color: colors.ambaganLedger }]}>
                        {(payingParticipant.participant?.full_name || payingParticipant.participant?.email || '?')[0].toUpperCase()}
                      </Text>
                    </View>
                    <View style={{ marginLeft: 10 }}>
                      <Text style={styles.payConfirmName}>
                        {payingParticipant.participant?.full_name || payingParticipant.participant?.email}
                      </Text>
                      <Text style={styles.payConfirmEmail}>{payingParticipant.participant?.email}</Text>
                    </View>
                  </View>
                  <Text style={styles.payConfirmAmount}>
                    {formatCurrency(remainingFor(payingParticipant))} left
                  </Text>
                </View>

                <View style={styles.fieldGroup}>
                  <Text style={styles.inputLabel}>Amount Paid (₱)</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="0.00"
                    placeholderTextColor={colors.textLight}
                    value={payAmount}
                    onChangeText={setPayAmount}
                    keyboardType="decimal-pad"
                  />
                </View>

                <Text style={styles.payMethodLabel}>Payment method used</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {PAYMENT_METHODS.map((m) => (
                      <TouchableOpacity
                        key={m}
                        style={[styles.methodChip, selectedPayMethod === m && styles.methodChipActive]}
                        onPress={() => setSelectedPayMethod(m)}
                      >
                        <Text style={[styles.methodChipText, selectedPayMethod === m && styles.methodChipTextActive]}>
                          {m}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>

                <TouchableOpacity style={styles.confirmBtn} onPress={confirmRecordPayment}>
                  <Ionicons name="checkmark-circle" size={18} color="#fff" />
                  <Text style={styles.confirmBtnText}>Save Payment</Text>
                </TouchableOpacity>
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <AppModal
        visible={showErrorModal}
        onClose={() => setShowErrorModal(false)}
        icon="alert-circle"
        iconColor={colors.error}
        title="Error"
        message={errorMsg}
        buttons={[{ label: 'Got It', onPress: () => setShowErrorModal(false) }]}
      />

      <AppModal
        visible={showSingilConfirm}
        onClose={() => setShowSingilConfirm(false)}
        icon="mail-outline"
        iconColor={colors.ambaganLedger}
        title="Send Singil"
        message={`Send collection email to ${singilTarget?.participant?.email || ''}?`}
        buttons={[
          { label: 'Cancel', variant: 'secondary', onPress: () => setShowSingilConfirm(false) },
          { label: 'Send', onPress: confirmSendGroupSingil },
        ]}
      />

      <AppModal
        visible={showSingilResult}
        onClose={() => setShowSingilResult(false)}
        icon={singilResultOk ? 'checkmark-circle' : 'close-circle'}
        iconColor={singilResultOk ? colors.success : colors.error}
        title={singilResultOk ? 'Sent!' : 'Failed'}
        message={singilResultMsg}
        buttons={[{ label: 'OK', onPress: () => setShowSingilResult(false) }]}
      />
    </View>
  );
}

const makeStyles = (colors: ReturnType<typeof import('../context/ThemeContext').useTheme>['colors']) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    loadingText: { color: colors.textSecondary, fontSize: 15 },
    header: {
      backgroundColor: colors.ambaganLedger, paddingTop: 56, paddingBottom: 16,
      paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    },
    backBtn: { padding: 8 },
    headerTitle: { color: '#fff', fontSize: 18, fontWeight: '700', flex: 1, textAlign: 'center' },
    summaryCard: { margin: 16, backgroundColor: colors.surface, borderRadius: 16, padding: 20, elevation: 2 },
    summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
    summaryLabel: { fontSize: 12, color: colors.textSecondary, marginBottom: 4 },
    summaryAmount: { fontSize: 28, fontWeight: '800', color: colors.ambaganLedger },
    statusBadge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
    statusText: { fontSize: 13, fontWeight: '700' },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 12 },
    metaItem: { minWidth: '45%' },
    metaLabel: { fontSize: 11, color: colors.textSecondary, marginBottom: 2 },
    metaValue: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
    paymentInfoRow: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: colors.primary + '12', borderRadius: 8,
      paddingHorizontal: 10, paddingVertical: 7, marginBottom: 12,
    },
    paymentInfoText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600', flex: 1 },
    progressSection: { marginTop: 4 },
    progressHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
    progressLabel: { fontSize: 13, color: colors.textSecondary },
    progressAmount: { fontSize: 13, fontWeight: '600', color: colors.success },
    progressBg: { height: 8, backgroundColor: colors.border, borderRadius: 4, overflow: 'hidden' },
    progressFill: { height: 8, backgroundColor: colors.success, borderRadius: 4 },
    section: { marginHorizontal: 16 },
    sectionTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary, marginBottom: 10 },
    emptyText: { color: colors.textLight, fontSize: 14, textAlign: 'center', padding: 16 },
    participantCard: {
      backgroundColor: colors.surface, borderRadius: 12, padding: 14,
      marginBottom: 8, elevation: 1,
    },
    participantPaid: { opacity: 0.75 },
    participantTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    participantLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
    avatar: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
    avatarText: { fontSize: 16, fontWeight: '700' },
    participantName: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
    participantEmail: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
    paidAt: { fontSize: 11, color: colors.success, marginTop: 2 },
    participantRight: { alignItems: 'flex-end', gap: 6 },
    shareAmount: { fontSize: 15, fontWeight: '800', color: colors.textPrimary },
    paidBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    paidText: { fontSize: 12, color: colors.success, fontWeight: '600' },
    partialBadge: { backgroundColor: colors.warning + '25', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
    partialText: { fontSize: 11, color: colors.warning, fontWeight: '600' },
    pendingBadge: { backgroundColor: colors.border, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
    pendingText: { fontSize: 11, color: colors.textSecondary, fontWeight: '600' },
    participantProgressSection: { marginTop: 10 },
    participantProgressBg: { height: 5, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden' },
    participantProgressFill: { height: 5, borderRadius: 3 },
    participantProgressText: { fontSize: 11, color: colors.textSecondary, marginTop: 4, fontWeight: '500' },
    actionRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
    recordPayBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.ambaganLedger, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8 },
    recordPayText: { fontSize: 12, color: '#fff', fontWeight: '700' },
    singilBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.secondary + '20', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8 },
    singilText: { fontSize: 12, color: colors.secondary, fontWeight: '600' },
    // Record Payment Modal
    modalOverlay: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' },
    modal: { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '85%' },
    modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
    modalTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
    closeBtn: { padding: 4, borderRadius: 20, backgroundColor: colors.border },
    payConfirmCard: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      backgroundColor: colors.background, borderRadius: 12, padding: 14,
      marginBottom: 16, borderWidth: 1, borderColor: colors.border,
    },
    payConfirmLeft: { flexDirection: 'row', alignItems: 'center' },
    payConfirmName: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
    payConfirmEmail: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
    payConfirmAmount: { fontSize: 15, fontWeight: '800', color: colors.ambaganLedger },
    fieldGroup: { marginBottom: 16 },
    inputLabel: {
      fontSize: 12, fontWeight: '700', color: colors.textSecondary,
      textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8,
    },
    input: {
      borderWidth: 1.5, borderColor: colors.border, borderRadius: 14,
      paddingHorizontal: 16, paddingVertical: 14,
      fontSize: 15, color: colors.textPrimary, backgroundColor: colors.background,
    },
    payMethodLabel: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 8 },
    methodChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: colors.border, marginRight: 8, backgroundColor: colors.background },
    methodChipActive: { backgroundColor: colors.ambaganLedger, borderColor: colors.ambaganLedger },
    methodChipText: { fontSize: 13, color: colors.textSecondary },
    methodChipTextActive: { color: '#fff', fontWeight: '600' },
    confirmBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      gap: 8, padding: 14, borderRadius: 12, backgroundColor: colors.ambaganLedger, marginBottom: 8,
    },
    confirmBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  });