bool TryRow(const TransitionRow& row) {
    if (row.guard != nullptr && (this->*row.guard)() == row.negate) {
        return false;
    }
    State root = row.source;
    while (ParentOf(root) != row.lca) {
        root = ParentOf(root);
    }
    ExitState(root);
    Invoke(row.action);
    EnterDown(row.lca, row.target);
    return true;
}
