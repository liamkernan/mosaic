"""Order-domain helpers."""


def calculate_order_total(lines: list[dict]) -> int:
    """Return an order total in cents."""
    return sum(line["unit_price_cents"] * line["quantity"] for line in lines)


def apply_delivery_update(order: dict, update: dict) -> dict:
    """Apply a delivery-address update received from the account event stream."""
    order["delivery_address"] = update["delivery_address"]
    order["delivery_update_sequence"] = update["sequence"]
    return order


def format_member_name(member: dict) -> str:
    """Format a stable display name for account messages."""
    return f'{member["first_name"]} {member["last_name"]}'.strip()
