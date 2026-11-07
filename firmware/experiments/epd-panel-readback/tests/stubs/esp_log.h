#pragma once
void test_log(const char *,const char *,...);
#define ESP_LOGI(...) test_log(__VA_ARGS__)
