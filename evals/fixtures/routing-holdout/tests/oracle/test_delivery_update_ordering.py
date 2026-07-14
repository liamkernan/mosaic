from copy import deepcopy

from portal.service import apply_delivery_update


def _order() -> dict:
    return {
        "id": "order-17",
        "delivery_address": "84 New Avenue",
        "delivery_update_sequence": 7,
        "total_cents": 1800,
    }


def test_older_or_repeated_delivery_updates_do_not_replace_current_state() -> None:
    for sequence in (6, 7):
        order = _order()
        original = deepcopy(order)
        update = {"sequence": sequence, "delivery_address": "12 Old Road"}
        original_update = deepcopy(update)
        assert apply_delivery_update(order, update) == original
        assert order == original
        assert update == original_update


def test_strictly_newer_delivery_update_changes_only_address_and_sequence() -> None:
    order = _order()
    update = {"sequence": 8, "delivery_address": "90 Current Street"}
    result = apply_delivery_update(order, update)
    assert result["delivery_address"] == "90 Current Street"
    assert result["delivery_update_sequence"] == 8
    assert result["id"] == "order-17"
    assert result["total_cents"] == 1800
