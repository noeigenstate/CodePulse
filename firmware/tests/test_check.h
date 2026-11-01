#pragma once
#include <stdio.h>
#include <stdlib.h>

/* Always evaluate the tested operation, including NDEBUG builds. */
#define CHECK(expression) do { \
  if (!(expression)) { \
    fprintf(stderr, "CHECK failed: %s (%s:%d)\n", #expression, __FILE__, __LINE__); \
    abort(); \
  } \
} while (0)
