from copy import deepcopy

from storefront.service import build_shipping_confirmation


def _order() -> dict:
    return {
        "id": "order-17",
        "shipping_address": "12 Old Road",
        "lines": [{"unit_price_cents": 900, "quantity": 2}],
    }


def test_confirmation_uses_the_customers_current_nonblank_address() -> None:
    customer = {"name": "Avery", "shipping_address": "84 New Avenue"}
    assert build_shipping_confirmation(_order(), customer)["shipping_address"] == "84 New Avenue"


def test_confirmation_falls_back_to_the_checkout_address_when_profile_address_is_blank() -> None:
    customer = {"name": "Avery", "shipping_address": "   "}
    assert build_shipping_confirmation(_order(), customer)["shipping_address"] == "12 Old Road"


def test_confirmation_does_not_mutate_order_or_customer_inputs() -> None:
    order = _order()
    customer = {"name": "Avery", "shipping_address": "84 New Avenue"}
    original_order = deepcopy(order)
    original_customer = deepcopy(customer)
    build_shipping_confirmation(order, customer)
    assert order == original_order
    assert customer == original_customer
