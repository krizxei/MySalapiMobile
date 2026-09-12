import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  Modal, TextInput, Alert, RefreshControl, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { format } from 'date-fns';
import DateInput from '../../components/DateInput';
import DraggableModal from '../../components/DraggableModal';

// One entry in custom split mode
interface CustomMember {
  email: string;
  amount: string;
}

export default function AmbaganScreen() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const [groups, setGroups] = useState<any[]>([]);
  const [groupCounts, setGroupCounts] = useState<Record<string, { collected: number; total: number; fullyPaid: number; participantCount: number }>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Shared fields
  const [title, setTitle] = useState('');
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().split('T')[0]);
  const [category, setCategory] = useState('Food');
  const [splitMode, setSplitMode] = useState<'equal' | 'custom'>('equal');
  const [paymentMethod, setPaymentMethod] = useState('GCash');
  const [paymentDetails, setPaymentDetails] = useState('');

  // Equal split — individual email rows (same UX as custom split)
  const [totalAmount, setTotalAmount] = useState('');
  const [equalMembers, setEqualMembers] = useState<string[]>(['']);

  const addEqualMember = () => setEqualMembers((prev) => [...prev, '']);
  const removeEqualMember = (index: number) => setEqualMembers((prev) => prev.filter((_, i) => i !== index));
  const updateEqualMember = (index: number, value: string) =>
    setEqualMembers((prev) => prev.map((e, i) => i === index ? value : e));

  // Custom split fields — list of { email, amount }
  const [customMembers, setCustomMembers] = useState<CustomMember[]>([{ email: '', amount: '' }]);

  const resetForm = () => {
    setTitle('');
    setTotalAmount('');
    setExpenseDate(new Date().toISOString().split('T')[0]);
    setCategory('Food');
    setSplitMode('equal');
    setPaymentMethod('GCash');
    setPaymentDetails('');
    setEqualMembers(['']);
    setCustomMembers([{ email: '', amount: '' }]);
  };

  const loadGroups = async () => {
    if (!user) return;
    const { data } = await supabase
      .from('group_expenses')
      .select('*')
      .or(`payer_id.eq.${user.id}`)
      .order('created_at', { ascending: false });
    setGroups(data || []);

    // Fetch participant payment progress for each group
    if (data && data.length > 0) {
      const ids = data.map((g: any) => g.id);
      const { data: participants } = await supabase
        .from('group_participants')
        .select('group_expense_id, share_amount, amount_paid')
        .in('group_expense_id', ids);

      const counts: Record<string, { collected: number; total: number; fullyPaid: number; participantCount: number }> = {};
      (participants || []).forEach((p: any) => {
        if (!counts[p.group_expense_id]) {
          counts[p.group_expense_id] = { collected: 0, total: 0, fullyPaid: 0, participantCount: 0 };
        }
        const share = Number(p.share_amount);
        const paid = Number(p.amount_paid || 0);
        counts[p.group_expense_id].collected += paid;
        counts[p.group_expense_id].total += share;
        counts[p.group_expense_id].participantCount++;
        if (paid >= share) counts[p.group_expense_id].fullyPaid++;
      });
      setGroupCounts(counts);
    }
  };

  useEffect(() => { loadGroups(); }, [user]);
  const onRefresh = async () => { setRefreshing(true); await loadGroups(); setRefreshing(false); };

  // ── Equal split ──────────────────────────────────────────────────────────
  const createEqualGroup = async () => {
    if (!title || !totalAmount) {
      Alert.alert('Error', 'Title and amount are required.');
      return;
    }
    const amount = parseFloat(totalAmount);
    if (isNaN(amount) || amount <= 0) { Alert.alert('Error', 'Enter a valid amount.'); return; }

    const emails = equalMembers.map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (emails.length === 0) { Alert.alert('Error', 'Add at least one member email.'); return; }

    const { data: memberUsers } = await supabase
      .from('users').select('id, email, full_name').in('email', emails);
    if (!memberUsers || memberUsers.length === 0) {
      Alert.alert('Error', 'No valid MySalapi users found with those emails.');
      return;
    }

    const totalMembers = memberUsers.length + 1; // +1 for payer
    const sharePerPerson = amount / totalMembers;

    const { data: group, error } = await supabase.from('group_expenses').insert({
      payer_id: user!.id, title, total_amount: amount,
      expense_date: expenseDate, category, split_method: 'equal', status: 'active',
      payment_method: paymentMethod, payment_details: paymentDetails,
    }).select().single();
    if (error || !group) { Alert.alert('Error', error?.message || 'Failed to create group.'); return; }

    await supabase.from('group_participants').insert(
      memberUsers.map((u: any) => ({
        group_expense_id: group.id, participant_id: u.id,
        share_amount: sharePerPerson, is_paid: false,
      }))
    );

    setShowCreate(false);
    resetForm();
    loadGroups();
  };

  // ── Custom split ─────────────────────────────────────────────────────────
  const createCustomGroup = async () => {
    if (!title) { Alert.alert('Error', 'Title is required.'); return; }

    const validMembers = customMembers.filter(
      (m) => m.email.trim() && m.amount.trim() && parseFloat(m.amount) > 0
    );
    if (validMembers.length === 0) {
      Alert.alert('Error', 'Add at least one member with a valid email and amount.');
      return;
    }

    // Validate all amounts are numbers
    for (const m of validMembers) {
      if (isNaN(parseFloat(m.amount)) || parseFloat(m.amount) <= 0) {
        Alert.alert('Error', `Invalid amount for ${m.email}`);
        return;
      }
    }

    const emails = validMembers.map((m) => m.email.trim().toLowerCase());
    const { data: memberUsers } = await supabase
      .from('users').select('id, email, full_name').in('email', emails);
    if (!memberUsers || memberUsers.length === 0) {
      Alert.alert('Error', 'No valid MySalapi users found with those emails.');
      return;
    }

    const totalAmt = validMembers.reduce((s, m) => s + parseFloat(m.amount), 0);

    const { data: group, error } = await supabase.from('group_expenses').insert({
      payer_id: user!.id, title, total_amount: totalAmt,
      expense_date: expenseDate, category, split_method: 'custom', status: 'active',
      payment_method: paymentMethod, payment_details: paymentDetails,
    }).select().single();
    if (error || !group) { Alert.alert('Error', error?.message || 'Failed to create group.'); return; }

    // Match each email to a user and insert with their specific amount
    const participantRows = validMembers.map((m) => {
      const found = memberUsers.find(
        (u: any) => u.email === m.email.trim().toLowerCase()
      );
      return found ? {
        group_expense_id: group.id,
        participant_id: found.id,
        share_amount: parseFloat(m.amount),
        is_paid: false,
      } : null;
    }).filter(Boolean);

    if (participantRows.length === 0) {
      Alert.alert('Error', 'None of the emails matched registered MySalapi users.');
      await supabase.from('group_expenses').delete().eq('id', group.id);
      return;
    }

    await supabase.from('group_participants').insert(participantRows);

    setShowCreate(false);
    resetForm();
    loadGroups();
  };

  const addCustomMember = () => {
    setCustomMembers((prev) => [...prev, { email: '', amount: '' }]);
  };

  const removeCustomMember = (index: number) => {
    setCustomMembers((prev) => prev.filter((_, i) => i !== index));
  };

  const updateCustomMember = (index: number, field: 'email' | 'amount', value: string) => {
    setCustomMembers((prev) =>
      prev.map((m, i) => i === index ? { ...m, [field]: value } : m)
    );
  };

  const customTotal = customMembers.reduce((s, m) => {
    const n = parseFloat(m.amount);
    return s + (isNaN(n) ? 0 : n);
  }, 0);

  const formatCurrency = (n: number) =>
    `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

  const styles = makeStyles(colors);

  return (
    <View style={styles.container}>
      {/* Modern Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Ambagan</Text>
          <Text style={styles.headerSubtitle}>Shared group expenses</Text>
        </View>
      </View>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        style={styles.list}
      >
        {groups.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Ionicons name="people-outline" size={56} color={colors.textLight} />
            <Text style={styles.emptyTitle}>No group expenses yet</Text>
            <Text style={styles.emptyText}>Tap + to create a shared expense with friends</Text>
          </View>
        ) : (
          groups.map((group) => {
            const counts = groupCounts[group.id];
            const pct = counts && counts.total > 0
              ? Math.min((counts.collected / counts.total) * 100, 100)
              : 0;
            return (
              <TouchableOpacity
                key={group.id}
                style={styles.groupCard}
                onPress={() => router.push({ pathname: '/group-detail' as any, params: { id: group.id } })}
              >
                <View style={styles.groupHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.groupTitle}>{group.title}</Text>
                    <Text style={styles.groupDate}>
                      {format(new Date(group.expense_date), 'MMM d, yyyy')} · {group.category}
                    </Text>
                  </View>
                  <Text style={styles.groupAmount}>{formatCurrency(group.total_amount)}</Text>
                </View>
                <View style={styles.groupFooter}>
                  <View style={styles.splitBadge}>
                    <Ionicons
                      name={group.split_method === 'equal' ? 'git-branch-outline' : 'options-outline'}
                      size={12}
                      color={colors.ambaganLedger}
                    />
                    <Text style={styles.groupSub}>
                      {group.split_method === 'equal' ? 'Equal split' : 'Custom split'}
                    </Text>
                  </View>
                  <View style={[styles.statusBadge, {
                    backgroundColor: group.status === 'settled' ? colors.success + '25' : colors.warning + '25',
                  }]}>
                    <Text style={[styles.statusText, {
                      color: group.status === 'settled' ? colors.success : colors.warning,
                    }]}>
                      {group.status === 'settled' ? 'Settled' : 'Active'}
                    </Text>
                  </View>
                </View>
                {/* Collected / Total indicator, based on actual amounts paid (reflects partial payments) */}
                {counts && (
                  <View style={styles.paidIndicatorRow}>
                    <View style={styles.paidIndicatorBar}>
                      <View style={[styles.paidIndicatorFill, { width: `${pct}%` as any }]} />
                    </View>
                    <Text style={styles.paidIndicatorText}>
                      {counts.fullyPaid}/{counts.participantCount} paid · {formatCurrency(counts.collected)} collected
                    </Text>
                  </View>
                )}
                <View style={styles.tapHint}>
                  <Ionicons name="chevron-forward" size={14} color={colors.textLight} />
                  <Text style={styles.tapHintText}>Tap to view participants</Text>
                </View>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      <TouchableOpacity style={styles.fab} onPress={() => setShowCreate(true)}>
        <Ionicons name="add" size={28} color="#fff" />
      </TouchableOpacity>

      {/* Create Group Modal */}
      <DraggableModal visible={showCreate} onClose={() => { setShowCreate(false); resetForm(); }}>
            {/* Modal header */}
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Create Group Expense</Text>
              <TouchableOpacity onPress={() => { setShowCreate(false); resetForm(); }} style={styles.closeBtn}>
                <Ionicons name="close" size={16} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* Common fields */}
              <View style={{ marginBottom: 20 }}>
                <Text style={styles.inputLabel}>Title</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Dinner at Jollibee"
                  placeholderTextColor={colors.textLight}
                  value={title}
                  onChangeText={setTitle}
                />
              </View>

              <View style={{ marginBottom: 20 }}>
                <DateInput label="Expense Date" value={expenseDate} onChange={setExpenseDate} />
              </View>

              <View style={{ marginBottom: 20 }}>
                <Text style={styles.inputLabel}>Category</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Food, Transport, etc."
                  placeholderTextColor={colors.textLight}
                  value={category}
                  onChangeText={setCategory}
                />
              </View>

              {/* Split mode toggle */}
              <View style={{ marginBottom: 20 }}>
                <Text style={styles.inputLabel}>Split Method</Text>
                <View style={styles.splitToggle}>
                  <TouchableOpacity
                    style={[styles.splitOption, splitMode === 'equal' && styles.splitOptionActive]}
                    onPress={() => setSplitMode('equal')}
                  >
                    <Ionicons name="git-branch-outline" size={16} color={splitMode === 'equal' ? '#fff' : colors.textSecondary} />
                    <Text style={[styles.splitOptionText, splitMode === 'equal' && styles.splitOptionTextActive]}>Equal Split</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.splitOption, splitMode === 'custom' && styles.splitOptionActive]}
                    onPress={() => setSplitMode('custom')}
                  >
                    <Ionicons name="options-outline" size={16} color={splitMode === 'custom' ? '#fff' : colors.textSecondary} />
                    <Text style={[styles.splitOptionText, splitMode === 'custom' && styles.splitOptionTextActive]}>Custom Split</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* ── Equal split fields ── */}
              {splitMode === 'equal' && (
                <>
                  <View style={{ marginBottom: 20 }}>
                    <Text style={styles.inputLabel}>Total Amount (₱)</Text>
                    <TextInput
                      style={styles.input} placeholder="0.00"
                      placeholderTextColor={colors.textLight}
                      value={totalAmount} onChangeText={setTotalAmount} keyboardType="decimal-pad"
                    />
                  </View>

                  <View style={{ marginBottom: 8 }}>
                    <View style={styles.customHeader}>
                      <Text style={styles.inputLabel}>Members</Text>
                      {equalMembers.filter(Boolean).length > 0 && totalAmount ? (
                        <Text style={styles.customTotal}>
                          {equalMembers.filter(Boolean).length + 1} people · ₱{(parseFloat(totalAmount) / (equalMembers.filter(Boolean).length + 1)).toFixed(2)} each
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.inputNote}>
                      The total will be split equally including you.
                    </Text>
                  </View>

                  {equalMembers.map((email, index) => (
                    <View key={index} style={[styles.memberRow, { marginBottom: 10 }]}>
                      <TextInput
                        style={[styles.input, styles.memberInput]}
                        placeholder={`Member ${index + 1} email`}
                        placeholderTextColor={colors.textLight}
                        value={email} onChangeText={(v) => updateEqualMember(index, v)}
                        autoCapitalize="none" keyboardType="email-address"
                      />
                      {equalMembers.length > 1 && (
                        <TouchableOpacity style={styles.inlineRemoveBtn} onPress={() => removeEqualMember(index)}>
                          <Ionicons name="trash-outline" size={16} color={colors.error} />
                        </TouchableOpacity>
                      )}
                    </View>
                  ))}

                  <TouchableOpacity style={[styles.addMemberBtn, { marginBottom: 20 }]} onPress={addEqualMember}>
                    <Ionicons name="add-circle-outline" size={18} color={colors.ambaganLedger} />
                    <Text style={styles.addMemberText}>Add Another Member</Text>
                  </TouchableOpacity>

                  <View style={{ marginBottom: 20 }}>
                    <Text style={styles.inputLabel}>Payment Method</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        {['GCash', 'Maya', 'BDO', 'BPI', 'Cash', 'Other'].map((m) => (
                          <TouchableOpacity key={m} style={[styles.methodChip, paymentMethod === m && styles.methodChipActive]} onPress={() => setPaymentMethod(m)}>
                            <Text style={[styles.methodChipText, paymentMethod === m && styles.methodChipTextActive]}>{m}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </ScrollView>
                  </View>
                  <View style={{ marginBottom: 20 }}>
                    <Text style={styles.inputLabel}>Payment Details</Text>
                    <TextInput
                      style={styles.input} placeholder="e.g. GCash number 09XXXXXXXXX"
                      placeholderTextColor={colors.textLight}
                      value={paymentDetails} onChangeText={setPaymentDetails}
                    />
                  </View>
                  <TouchableOpacity style={[styles.saveBtn, { backgroundColor: colors.ambaganLedger, shadowColor: colors.ambaganLedger }]} onPress={createEqualGroup}>
                    <Text style={styles.saveBtnText}>Create Group</Text>
                  </TouchableOpacity>
                </>
              )}

              {/* ── Custom split fields ── */}
              {splitMode === 'custom' && (
                <>
                  <View style={{ marginBottom: 8 }}>
                    <View style={styles.customHeader}>
                      <Text style={styles.inputLabel}>Members & Amounts</Text>
                      {customTotal > 0 && <Text style={styles.customTotal}>Total: {formatCurrency(customTotal)}</Text>}
                    </View>
                    <Text style={styles.inputNote}>Enter each member's email and how much they owe you.</Text>
                  </View>

                  {customMembers.map((member, index) => (
                    <View key={index} style={[styles.memberRow, { marginBottom: 10 }]}>
                      <TextInput
                        style={[styles.input, { flex: 2, marginRight: 8 }]}
                        placeholder="email@example.com"
                        placeholderTextColor={colors.textLight}
                        value={member.email} onChangeText={(v) => updateCustomMember(index, 'email', v)}
                        autoCapitalize="none" keyboardType="email-address"
                      />
                      <TextInput
                        style={[styles.input, { flex: 1 }]}
                        placeholder="₱0.00"
                        placeholderTextColor={colors.textLight}
                        value={member.amount} onChangeText={(v) => updateCustomMember(index, 'amount', v)}
                        keyboardType="decimal-pad"
                      />
                      {customMembers.length > 1 && (
                        <TouchableOpacity style={styles.inlineRemoveBtn} onPress={() => removeCustomMember(index)}>
                          <Ionicons name="trash-outline" size={16} color={colors.error} />
                        </TouchableOpacity>
                      )}
                    </View>
                  ))}

                  <TouchableOpacity style={[styles.addMemberBtn, { marginBottom: 20 }]} onPress={addCustomMember}>
                    <Ionicons name="add-circle-outline" size={18} color={colors.ambaganLedger} />
                    <Text style={styles.addMemberText}>Add Another Member</Text>
                  </TouchableOpacity>

                  <View style={{ marginBottom: 20 }}>
                    <Text style={styles.inputLabel}>Payment Method</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        {['GCash', 'Maya', 'BDO', 'BPI', 'Cash', 'Other'].map((m) => (
                          <TouchableOpacity key={m} style={[styles.methodChip, paymentMethod === m && styles.methodChipActive]} onPress={() => setPaymentMethod(m)}>
                            <Text style={[styles.methodChipText, paymentMethod === m && styles.methodChipTextActive]}>{m}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </ScrollView>
                  </View>
                  <View style={{ marginBottom: 20 }}>
                    <Text style={styles.inputLabel}>Payment Details</Text>
                    <TextInput
                      style={styles.input} placeholder="e.g. GCash number 09XXXXXXXXX"
                      placeholderTextColor={colors.textLight}
                      value={paymentDetails} onChangeText={setPaymentDetails}
                    />
                  </View>
                  <TouchableOpacity style={[styles.saveBtn, { backgroundColor: colors.ambaganLedger, shadowColor: colors.ambaganLedger, marginTop: 4 }]} onPress={createCustomGroup}>
                    <Text style={styles.saveBtnText}>Create Group</Text>
                  </TouchableOpacity>
                </>
              )}
            </ScrollView>
      </DraggableModal>
    </View>
  );
}

const makeStyles = (colors: ReturnType<typeof import('../../context/ThemeContext').useTheme>['colors']) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: { 
      backgroundColor: colors.ambaganLedger, 
      padding: 24, 
      paddingTop: 56, 
      paddingBottom: 24,
      borderBottomLeftRadius: 24,
      borderBottomRightRadius: 24,
    },
    headerTitle: { color: '#fff', fontSize: 24, fontWeight: '700', letterSpacing: 0.3 },
    headerSubtitle: { color: 'rgba(255,255,255,0.8)', fontSize: 13, marginTop: 4, fontWeight: '500' },
    list: { flex: 1, padding: 16, paddingTop: 16 },
    emptyContainer: { alignItems: 'center', paddingTop: 72, paddingHorizontal: 32 },
    emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.textSecondary, marginTop: 16, marginBottom: 8 },
    emptyText: { fontSize: 14, color: colors.textLight, textAlign: 'center', lineHeight: 22, fontWeight: '500' },
    groupCard: { 
      backgroundColor: colors.surface, 
      borderRadius: 14, 
      padding: 14, 
      marginBottom: 10,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.04,
      shadowRadius: 4,
      elevation: 1,
      borderWidth: 1,
      borderColor: colors.borderLight || colors.border,
    },
    groupHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
    groupTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary, letterSpacing: 0.2, marginBottom: 2 },
    groupDate: { fontSize: 12, color: colors.textSecondary, marginTop: 2, fontWeight: '500' },
    groupAmount: { fontSize: 16, fontWeight: '800', color: colors.ambaganLedger, letterSpacing: 0.3 },
    groupFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.borderLight || colors.border },
    splitBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    groupSub: { fontSize: 12, color: colors.ambaganLedger, fontWeight: '700' },
    statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
    statusText: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
    tapHint: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    tapHintText: { fontSize: 11, color: colors.textLight, fontWeight: '500' },
    fab: {
      position: 'absolute', 
      bottom: 24, 
      right: 24,
      backgroundColor: colors.ambaganLedger, 
      width: 60, 
      height: 60,
      borderRadius: 30, 
      justifyContent: 'center', 
      alignItems: 'center',
      shadowColor: colors.ambaganLedger,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.4,
      shadowRadius: 12,
      elevation: 8,
    },
    // Modal
    modalOverlay: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' },
    modalBackdrop: { flex: 1 },
    modal: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 28, borderTopRightRadius: 28,
      paddingHorizontal: 24, paddingTop: 12, paddingBottom: 32,
      maxHeight: '90%',
    },
    modalDragHandle: {
      width: 40, height: 4, borderRadius: 2,
      backgroundColor: colors.border, alignSelf: 'center', marginBottom: 20,
    },
    modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
    modalTitle: { fontSize: 20, fontWeight: '800', color: colors.textPrimary, letterSpacing: 0.2 },
    closeBtn: {
      width: 32, height: 32, borderRadius: 16,
      backgroundColor: colors.borderLight,
      justifyContent: 'center', alignItems: 'center',
    },
    inputLabel: {
      fontSize: 12, fontWeight: '700', color: colors.textSecondary,
      textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8,
    },
    input: {
      borderWidth: 1.5, borderColor: colors.border, borderRadius: 14,
      paddingHorizontal: 16, paddingVertical: 14,
      fontSize: 15, marginBottom: 0,
      color: colors.textPrimary, backgroundColor: colors.background,
    },
    inputNote: { fontSize: 12, color: colors.textLight, marginTop: 6, marginBottom: 0, lineHeight: 18 },
    saveBtn: {
      padding: 16, borderRadius: 14, alignItems: 'center', marginBottom: 8,
      shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4,
    },
    saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 16, letterSpacing: 0.3 },
    // Split toggle
    splitToggle: { flexDirection: 'row', gap: 10, marginBottom: 16 },
    splitOption: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      gap: 6, paddingVertical: 10, borderRadius: 10,
      borderWidth: 1.5, borderColor: colors.border,
      backgroundColor: colors.background,
    },
    splitOptionActive: { backgroundColor: colors.ambaganLedger, borderColor: colors.ambaganLedger },
    splitOptionText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
    splitOptionTextActive: { color: '#fff' },
    // Custom split
    customHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
    customTotal: { fontSize: 13, fontWeight: '700', color: colors.ambaganLedger },
    // Member row — inline trash button, no extra gap
    memberRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
    memberInput: { flex: 1, marginBottom: 0 },
    inlineRemoveBtn: {
      padding: 8, borderRadius: 8,
      backgroundColor: colors.error + '15',
    },    addMemberBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingVertical: 10, paddingHorizontal: 14,
      borderRadius: 10, borderWidth: 1.5,
      borderColor: colors.ambaganLedger, borderStyle: 'dashed',
      justifyContent: 'center', marginBottom: 4,
    },
    addMemberText: { fontSize: 14, color: colors.ambaganLedger, fontWeight: '600' },
    // Payment method chips
    methodChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: colors.border, marginRight: 8, backgroundColor: colors.background },
    methodChipActive: { backgroundColor: colors.ambaganLedger, borderColor: colors.ambaganLedger },
    methodChipText: { fontSize: 13, color: colors.textSecondary },
    methodChipTextActive: { color: '#fff', fontWeight: '600' },
    // Paid indicator on card
    paidIndicatorRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
    paidIndicatorBar: { flex: 1, height: 5, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden' },
    paidIndicatorFill: { height: 5, backgroundColor: colors.success, borderRadius: 3 },
    paidIndicatorText: { fontSize: 11, fontWeight: '700', color: colors.textSecondary, minWidth: 50, textAlign: 'right' },
  });