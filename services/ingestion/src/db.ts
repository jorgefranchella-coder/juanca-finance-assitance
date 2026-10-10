import pg from 'pg';
pg.types.setTypeParser(1082,value=>value);
export function pool(user='juanca_ingestion',database=process.env.JUANCA_DATABASE??'juanca_shadow'){
 return new pg.Pool({host:process.env.JUANCA_PG_SOCKET??'/home/jorge/.local/share/juanca-shadow/socket',port:55432,user,database,max:4,connectionTimeoutMillis:3000,idleTimeoutMillis:10000,options:'-c timezone=UTC -c statement_timeout=15000'});
}
