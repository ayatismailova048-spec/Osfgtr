#!/usr/bin/env python3
"""Печатная версия недельного расписания из index.html.
Запуск: python3 tools/print_week.py [ГГГГ-ММ-ДД понедельника ...]
Без аргументов делает текущую и следующую неделю."""
import re, sys, datetime as dt
from pathlib import Path
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, PageBreak, Spacer

root = Path(__file__).resolve().parent.parent
src = (root / "cf" / "public" / "schedule.js").read_text(encoding="utf-8")
TASKS = {k: (n, int(p)) for k, n, p in re.findall(r'(\w+):\["([^"]+)",(\d+)\]', src.split("const TASKS=")[1].split("};")[0])}
cyc = src.split("const CYCLE=")[1].split(";\nconst DAYS")[0]
CYCLE = eval(cyc.replace("'", '"'))
NAMES = re.findall(r'"([^"]+)"', re.search(r"const NAMES=\[(.*?)\]", src).group(1))
REF = dt.date(2026, 11, 16)
DAYS = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"]
MONTHS = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"]

def assign(d):
    n = (d - REF).days; c = n // 4; day = CYCLE[n % 4]
    return [day[(p - n - c) % 4] for p in range(len(NAMES))]

pdfmetrics.registerFont(TTFont("F", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("FB", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))
cell = ParagraphStyle("c", fontName="F", fontSize=9.5, leading=12.5)
head = ParagraphStyle("h", fontName="FB", fontSize=11, leading=13, alignment=1)
dayst = ParagraphStyle("d", fontName="FB", fontSize=10, leading=12.5)
title = ParagraphStyle("t", fontName="FB", fontSize=17, leading=21)
small = ParagraphStyle("s", fontName="F", fontSize=8.5, leading=11, textColor=colors.HexColor("#444444"))

def fmt(d): return f"{d.day} {MONTHS[d.month-1]}"

def week_story(monday):
    st = [Paragraph(f"Домашние дела: неделя {fmt(monday)} – {fmt(monday + dt.timedelta(days=6))}", title), Spacer(1, 4*mm)]
    rows = [[Paragraph("День", head)] + [Paragraph(n, head) for n in NAMES]]
    for i in range(7):
        d = monday + dt.timedelta(days=i)
        row = [Paragraph(f"{DAYS[i]}<br/><font size=8.5 name=F>{fmt(d)}</font>", dayst)]
        for items in assign(d):
            row.append([Paragraph(f"□ {TASKS[t][0]} <font name=FB>({TASKS[t][1]})</font>", cell) for t in items])
        rows.append(row)
    w = landscape(A4)[0] - 20*mm
    t = Table(rows, colWidths=[37*mm] + [(w - 37*mm) / len(NAMES)] * len(NAMES), repeatRows=1)
    t.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.6, colors.black), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e6e6e6")),
        ("BACKGROUND", (0, 1), (0, -1), colors.HexColor("#f3f3f3")), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    st += [t, Spacer(1, 3*mm), Paragraph("В скобках баллы. У каждого человека по 5 баллов в день. Мусор и воду (воду через день) делают двое вместе. Отметьте выполненное в квадрате.", small)]
    return st

def main():
    args = sys.argv[1:]
    if args:
        mons = [dt.date.fromisoformat(a) for a in args]
    else:
        t = dt.date.today(); m = t - dt.timedelta(days=t.weekday()); mons = [m, m + dt.timedelta(days=7)]
    for m in mons:
        if m.weekday() != 0: sys.exit(f"{m} не понедельник")
    out = root / "print" / f"nedelya_{mons[0].isoformat()}.pdf"
    doc = SimpleDocTemplate(str(out), pagesize=landscape(A4), leftMargin=10*mm, rightMargin=10*mm, topMargin=8*mm, bottomMargin=8*mm,
                            title="Домашние дела: расписание на неделю")
    story = []
    for i, m in enumerate(mons):
        if i: story.append(PageBreak())
        story += week_story(m)
    doc.build(story); print(out)
main()
