import psycopg
from psycopg import sql


def formatted(cursor, table, name):
    # ruleid: no-sql-built-by-string-formatting-python
    cursor.execute(f"select * from {table}")
    # ruleid: no-sql-built-by-string-formatting-python
    cursor.execute("select * from %s" % table)
    # ruleid: no-sql-built-by-string-formatting-python
    cursor.execute("select * from {}".format(table))
    # ruleid: no-sql-built-by-string-formatting-python
    cursor.execute("select * from " + table)
    # ruleid: no-sql-built-by-string-formatting-python
    cursor.executemany(f"insert into {table} values (%s)", [(name,)])
    # ruleid: no-sql-built-by-string-formatting-python
    psycopg.connect().execute(f"drop table {table}")


def built_first(cursor, table):
    query = f"select * from {table}"
    # ruleid: no-sql-built-by-string-formatting-python
    cursor.execute(query)


def safe(cursor, table, name):
    # ok: no-sql-built-by-string-formatting-python
    cursor.execute("select * from users where name = %s", (name,))
    # ok: no-sql-built-by-string-formatting-python
    cursor.execute("select 1")
    # ok: no-sql-built-by-string-formatting-python
    cursor.execute(sql.SQL("select * from {}").format(sql.Identifier(table)))
    # ok: no-sql-built-by-string-formatting-python
    print(f"loaded {table}")
