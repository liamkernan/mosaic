from portal.repository import create_export_job, list_export_jobs, reset_export_jobs
from portal.service import calculate_order_total, format_member_name


def test_order_total_uses_price_and_quantity() -> None:
    lines = [
        {"unit_price_cents": 1200, "quantity": 2},
        {"unit_price_cents": 500, "quantity": 1},
    ]
    assert calculate_order_total(lines) == 2900


def test_member_name_remains_stable() -> None:
    assert format_member_name({"first_name": "Avery", "last_name": "Stone"}) == "Avery Stone"


def test_export_repository_lists_created_jobs() -> None:
    reset_export_jobs()
    created = create_export_job("member-1")
    assert list_export_jobs() == [created]
