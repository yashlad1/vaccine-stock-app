import sweep


def test_sweep_no_mismatch():
    bad = sweep.run(10000, 1)
    assert not bad, f"{len(bad)} mismatches, first:\n" + "\n".join(bad[:5])
