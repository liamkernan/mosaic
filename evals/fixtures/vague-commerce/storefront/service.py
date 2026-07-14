"""Small order helpers used by the deterministic Mosaic benchmark."""


def calculate_order_total(lines: list[dict]) -> int:
    """Return the order total in cents."""
    return sum(line["unit_price_cents"] * line["quantity"] for line in lines)


def build_shipping_confirmation(order: dict, customer: dict) -> dict:
    """Build the data rendered in the shipping-confirmation message."""
    return {
        "order_id": order["id"],
        "customer_name": customer["name"],
        "shipping_address": order["shipping_address"],
        "total_cents": calculate_order_total(order["lines"]),
    }


def rank_support_requests(requests: list[dict]) -> list[dict]:
    """Keep the support board newest-first."""
    return sorted(requests, key=lambda request: request["created_at"], reverse=True)
