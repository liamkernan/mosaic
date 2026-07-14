from storefront.service import build_shipping_confirmation, calculate_order_total, rank_support_requests


def test_calculate_order_total_uses_quantity() -> None:
    lines = [
        {"unit_price_cents": 1200, "quantity": 2},
        {"unit_price_cents": 500, "quantity": 1},
    ]
    assert calculate_order_total(lines) == 2900


def test_confirmation_preserves_order_identity_and_total() -> None:
    order = {
        "id": "order-17",
        "shipping_address": "12 Old Road",
        "lines": [{"unit_price_cents": 900, "quantity": 2}],
    }
    customer = {"name": "Avery", "shipping_address": "84 New Avenue"}
    confirmation = build_shipping_confirmation(order, customer)
    assert confirmation["order_id"] == "order-17"
    assert confirmation["customer_name"] == "Avery"
    assert confirmation["total_cents"] == 1800


def test_support_requests_remain_newest_first() -> None:
    requests = [
        {"id": "older", "created_at": "2026-07-10T10:00:00Z"},
        {"id": "newer", "created_at": "2026-07-10T12:00:00Z"},
    ]
    assert [request["id"] for request in rank_support_requests(requests)] == ["newer", "older"]
